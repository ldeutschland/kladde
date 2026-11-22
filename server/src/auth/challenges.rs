use crate::{App, Result, Shared, bad, denied};
use kladde_crypto::opaque::*;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, time::Instant};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub enum Challenge {
    Login(String, Box<ServerLogin<Suite>>),
    Ticket(Uuid, [u8; 32]),
    Recovery(Uuid),
    Rekey(Uuid),
    Renew(Uuid),
}

impl Challenge {
    fn kind(&self) -> u8 {
        match self {
            Self::Login(..) => 0,
            Self::Ticket(..) => 1,
            Self::Recovery(_) => 2,
            Self::Rekey(_) => 3,
            Self::Renew(_) => 4,
        }
    }
}

const CHALLENGE_SECONDS: u64 = 90;
const CHALLENGES_PER_KIND: usize = 2048;

pub(super) fn open_challenge(relay: &Shared, challenge: Challenge) -> Result<Uuid> {
    let mut challenges = relay.challenges.lock().map_err(|_| bad())?;

    challenges.retain(|_, (time, _)| time.elapsed().as_secs() < CHALLENGE_SECONDS);

    if !has_room(&challenges, challenge.kind()) {
        drop_oldest(&mut challenges, challenge.kind());
    }

    let id = Uuid::new_v4();

    challenges.insert(id, (Instant::now(), challenge));

    Ok(id)
}

fn has_room(open: &HashMap<Uuid, (Instant, Challenge)>, kind: u8) -> bool {
    open.values().filter(|(_, c)| c.kind() == kind).count() < CHALLENGES_PER_KIND
}

fn drop_oldest(open: &mut HashMap<Uuid, (Instant, Challenge)>, kind: u8) {
    let oldest = open
        .iter()
        .filter(|(_, (_, c))| c.kind() == kind)
        .min_by_key(|(_, (time, _))| *time)
        .map(|(id, _)| *id);
    if let Some(id) = oldest {
        open.remove(&id);
    }
}

pub(super) fn take_challenge(relay: &Shared, id: Uuid) -> Result<Challenge> {
    let (created, challenge) = relay
        .challenges
        .lock()
        .map_err(|_| bad())?
        .remove(&id)
        .ok_or_else(denied)?;
    if created.elapsed().as_secs() >= CHALLENGE_SECONDS {
        return Err(denied());
    }

    Ok(challenge)
}

pub(super) fn take_ticket(relay: &App, ticket: &str) -> Result<Uuid> {
    let (id, key) = ticket.split_once(':').ok_or_else(denied)?;
    let Challenge::Ticket(account, expected) =
        take_challenge(relay, id.parse().map_err(|_| denied())?)?
    else {
        return Err(denied());
    };

    if !bool::from(expected.ct_eq(Sha256::digest(key.as_bytes()).as_slice())) {
        return Err(denied());
    }

    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_kind_of_challenge_leaves_the_others_open() {
        let mut open = HashMap::new();

        for _ in 0..CHALLENGES_PER_KIND {
            open.insert(
                Uuid::new_v4(),
                (Instant::now(), Challenge::Renew(Uuid::new_v4())),
            );
        }

        assert!(!has_room(&open, Challenge::Renew(Uuid::nil()).kind()));
        assert!(has_room(&open, Challenge::Recovery(Uuid::nil()).kind()));
        assert!(has_room(&open, Challenge::Rekey(Uuid::nil()).kind()));
    }
}
