use axum::http::HeaderMap;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_TRACKED: usize = 65536;
const SWEEP_INTERVAL: Duration = Duration::from_secs(1);
const MINUTE: Duration = Duration::from_secs(60);
const LOGIN_ATTEMPTS: u32 = 10;
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
const CLIENT_STARTS: u32 = 30;
const CLIENT_REQUESTS: u32 = 3000;
const ACCOUNT_REQUESTS: u32 = 1800;
const ACCOUNT_MESSAGES: u32 = 12000;

struct Window {
    opened: Instant,
    used: u32,
}

struct Windows {
    open: HashMap<String, Window>,
    swept: Instant,
}

impl Windows {
    fn has_room(&mut self, period: Duration) -> bool {
        if self.open.len() < MAX_TRACKED {
            return true;
        }

        if self.swept.elapsed() < SWEEP_INTERVAL {
            return false;
        }

        self.swept = Instant::now();
        self.open
            .retain(|_, window| window.opened.elapsed() < period);

        self.open.len() < MAX_TRACKED
    }
}

pub struct Throttle {
    budget: u32,
    period: Duration,
    windows: Mutex<Windows>,
}

impl Throttle {
    fn new(budget: u32, period: Duration) -> Self {
        Self {
            budget,
            period,
            windows: Mutex::new(Windows {
                open: HashMap::new(),
                swept: Instant::now(),
            }),
        }
    }

    pub fn logins() -> Self {
        Self::new(LOGIN_ATTEMPTS, LOGIN_WINDOW)
    }

    pub fn clients() -> Self {
        Self::new(CLIENT_STARTS, MINUTE)
    }

    pub fn client_requests() -> Self {
        Self::new(CLIENT_REQUESTS, MINUTE)
    }

    pub fn account_requests() -> Self {
        Self::new(ACCOUNT_REQUESTS, MINUTE)
    }

    pub fn account_messages() -> Self {
        Self::new(ACCOUNT_MESSAGES, MINUTE)
    }

    pub fn allow(&self, key: &str) -> bool {
        let Ok(mut windows) = self.windows.lock() else {
            return false;
        };

        if !windows.open.contains_key(key) && !windows.has_room(self.period) {
            return false;
        }

        let window = windows.open.entry(key.to_owned()).or_insert(Window {
            opened: Instant::now(),
            used: 0,
        });

        if window.opened.elapsed() >= self.period {
            window.opened = Instant::now();
            window.used = 0;
        }

        if window.used >= self.budget {
            return false;
        }

        window.used += 1;

        true
    }

    pub fn forget(&self, key: &str) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.open.remove(key);
        }
    }
}

pub fn forwarded_client(headers: &HeaderMap) -> Option<String> {
    let forwarded = headers.get("x-forwarded-for")?.to_str().ok()?;
    let nearest = forwarded.rsplit(',').next()?.trim();
    let address: IpAddr = nearest.parse().ok()?;

    Some(network(address.to_canonical()))
}

fn network(address: IpAddr) -> String {
    match address {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            let segments = v6.segments();

            format!(
                "{:x}:{:x}:{:x}:{:x}::/64",
                segments[0], segments[1], segments[2], segments[3]
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_counts_down_and_forgetting_resets_it() {
        let throttle = Throttle::new(2, MINUTE);

        assert!(throttle.allow("a"));
        assert!(throttle.allow("a"));
        assert!(!throttle.allow("a"));
        assert!(throttle.allow("b"));
        throttle.forget("a");
        assert!(throttle.allow("a"));
    }

    #[test]
    fn a_full_table_refuses_new_keys_instead_of_evicting_running_ones() {
        let throttle = Throttle::new(1, MINUTE);

        for n in 0..MAX_TRACKED {
            assert!(throttle.allow(&n.to_string()));
        }

        assert!(!throttle.allow("newcomer"));
        assert!(!throttle.allow("0"));
        assert_eq!(throttle.windows.lock().unwrap().open.len(), MAX_TRACKED);
    }

    #[test]
    fn expired_windows_make_room_at_the_next_sweep() {
        let throttle = Throttle::new(1, Duration::ZERO);

        for n in 0..MAX_TRACKED {
            throttle.allow(&n.to_string());
        }

        throttle.windows.lock().unwrap().swept = Instant::now() - SWEEP_INTERVAL;
        assert!(throttle.allow("newcomer"));
        assert!(throttle.windows.lock().unwrap().open.len() <= 1);
    }
}
