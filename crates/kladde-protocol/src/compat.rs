use crate::{Header, Invalid};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const PROTOCOL: Range = Range { min: 1, max: 1 };
pub const LEGACY_PROTOCOL: Range = Range { min: 1, max: 1 };
pub const FORMAT: u8 = 1;
pub const LEGACY_FORMAT: u8 = 1;
pub const PROTOCOL_HEADER: &str = "kladde-protocol";
pub const FEATURES_HEADER: &str = "kladde-features";
pub const FORMAT_HEADER: &str = "kladde-format";
pub const OUTDATED_HEADER: &str = "kladde-outdated";
pub const MAX_FEATURES: usize = 64;
const MAX_HEADER: usize = 512;
const MAX_NAME: usize = 32;
const MAX_DIGITS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Feature {
    State,
    BlobList,
    Checkpoints,
    Watch,
    Discard,
    Full,
    Outdated,
    Formats,
    Proofs,
}

pub const ALL_FEATURES: [Feature; 9] = [
    Feature::State,
    Feature::BlobList,
    Feature::Checkpoints,
    Feature::Watch,
    Feature::Discard,
    Feature::Full,
    Feature::Outdated,
    Feature::Formats,
    Feature::Proofs,
];
pub const CLIENT_FEATURES: [Feature; 4] = [
    Feature::Checkpoints,
    Feature::Full,
    Feature::Outdated,
    Feature::Proofs,
];
pub const LEGACY_CLIENT_FEATURES: [Feature; 2] = [Feature::Checkpoints, Feature::Full];
pub const RELAY_FEATURES: [Feature; 7] = [
    Feature::State,
    Feature::BlobList,
    Feature::Checkpoints,
    Feature::Watch,
    Feature::Discard,
    Feature::Formats,
    Feature::Proofs,
];
pub const RELAY_REQUIRES: [Feature; 1] = [Feature::Checkpoints];

impl Feature {
    pub fn name(self) -> &'static str {
        match self {
            Feature::State => "state",
            Feature::BlobList => "blob_list",
            Feature::Checkpoints => "checkpoints",
            Feature::Watch => "watch",
            Feature::Discard => "discard",
            Feature::Full => "full",
            Feature::Outdated => "outdated",
            Feature::Formats => "formats",
            Feature::Proofs => "proofs",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        ALL_FEATURES.into_iter().find(|f| f.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    App,
    Server,
}

impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Side::App => "app",
            Side::Server => "server",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        [Side::App, Side::Server]
            .into_iter()
            .find(|side| side.name() == name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Invalid,
    Outdated(Side),
}

impl From<Invalid> for Refusal {
    fn from(_: Invalid) -> Self {
        Refusal::Invalid
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub min: u8,
    pub max: u8,
}

impl Range {
    pub fn parse(value: &str) -> Result<Self, Invalid> {
        let (min, max) = value.split_once('-').ok_or(Invalid)?;
        let range = Self {
            min: number(min)?,
            max: number(max)?,
        };

        range.checked()
    }

    pub fn value(self) -> String {
        format!("{}-{}", self.min, self.max)
    }

    fn checked(self) -> Result<Self, Invalid> {
        if self.min == 0 || self.min > self.max {
            return Err(Invalid);
        }

        Ok(self)
    }
}

fn number(text: &str) -> Result<u8, Invalid> {
    if text.is_empty() || text.len() > MAX_DIGITS || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Invalid);
    }

    text.parse().map_err(|_| Invalid)
}

pub fn parse_format(value: &str) -> Result<u8, Invalid> {
    match number(value)? {
        0 => Err(Invalid),
        format => Ok(format),
    }
}

pub fn negotiate(app: Range, relay: Range) -> Result<u8, Side> {
    if app.max < relay.min {
        return Err(Side::App);
    }

    if relay.max < app.min {
        return Err(Side::Server);
    }

    Ok(app.max.min(relay.max))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

pub fn parse_features(value: &str) -> Result<BTreeSet<Feature>, Invalid> {
    if value.len() > MAX_HEADER {
        return Err(Invalid);
    }

    let names: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect();
    if names.len() > MAX_FEATURES || !names.iter().all(|name| valid_name(name)) {
        return Err(Invalid);
    }

    Ok(names.into_iter().filter_map(Feature::parse).collect())
}

pub fn features_value(features: &[Feature]) -> String {
    names(features).join(",")
}

fn names(features: &[Feature]) -> Vec<String> {
    features.iter().map(|f| f.name().to_owned()).collect()
}

pub fn client_headers() -> [(&'static str, String); 3] {
    [
        (PROTOCOL_HEADER, PROTOCOL.value()),
        (FEATURES_HEADER, features_value(&CLIENT_FEATURES)),
        (FORMAT_HEADER, FORMAT.to_string()),
    ]
}

pub fn shared_format(others: impl IntoIterator<Item = u8>) -> u8 {
    others.into_iter().fold(FORMAT, u8::min).max(LEGACY_FORMAT)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: Range,
    pub features: Vec<String>,
    pub requires: Vec<String>,
}

impl Hello {
    pub fn relay() -> Self {
        Self {
            protocol: PROTOCOL,
            features: names(&RELAY_FEATURES),
            requires: names(&RELAY_REQUIRES),
        }
    }

    pub fn offered(&self) -> Result<BTreeSet<Feature>, Refusal> {
        self.protocol.checked()?;
        let listed = [&self.features, &self.requires];

        if listed
            .iter()
            .any(|names| names.len() > MAX_FEATURES || !names.iter().all(|n| valid_name(n)))
        {
            return Err(Refusal::Invalid);
        }

        negotiate(PROTOCOL, self.protocol).map_err(Refusal::Outdated)?;

        if !self.requires.iter().all(|name| understood(name)) {
            return Err(Refusal::Outdated(Side::App));
        }

        Ok(self
            .features
            .iter()
            .filter_map(|n| Feature::parse(n))
            .collect())
    }

    pub fn behind(&self) -> bool {
        self.protocol.max < PROTOCOL.max
            || RELAY_FEATURES
                .iter()
                .any(|feature| !self.features.iter().any(|name| name == feature.name()))
    }
}

fn understood(name: &str) -> bool {
    Feature::parse(name).is_some_and(|feature| CLIENT_FEATURES.contains(&feature))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peer {
    pub features: BTreeSet<Feature>,
    pub format: u8,
}

impl Peer {
    pub fn legacy() -> Self {
        Self {
            features: LEGACY_CLIENT_FEATURES.into_iter().collect(),
            format: LEGACY_FORMAT,
        }
    }

    pub fn admit(
        protocol: Option<&str>,
        features: Option<&str>,
        format: Option<&str>,
    ) -> Result<Self, Refusal> {
        let range = protocol.map(Range::parse).transpose()?;
        let features = features.map(parse_features).transpose()?;
        let format = format.map(parse_format).transpose()?;

        negotiate(range.unwrap_or(LEGACY_PROTOCOL), PROTOCOL).map_err(Refusal::Outdated)?;
        let legacy = Self::legacy();
        let peer = Self {
            features: features.unwrap_or(legacy.features),
            format: format.unwrap_or(legacy.format),
        };

        if !RELAY_REQUIRES.iter().all(|f| peer.has(*f)) {
            return Err(Refusal::Outdated(Side::App));
        }

        Ok(peer)
    }

    pub fn has(&self, feature: Feature) -> bool {
        self.features.contains(&feature)
    }

    pub fn reads(&self, header: &Header) -> bool {
        header.version <= self.format
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_names_the_side_that_must_update() {
        let range = |min, max| Range { min, max };

        assert_eq!(negotiate(range(1, 3), range(2, 5)), Ok(3));
        assert_eq!(negotiate(range(1, 1), range(2, 3)), Err(Side::App));
        assert_eq!(negotiate(range(4, 5), range(1, 3)), Err(Side::Server));
        assert_eq!(negotiate(PROTOCOL, PROTOCOL), Ok(PROTOCOL.max));
    }

    #[test]
    fn ranges_and_formats_reject_malformed_values() {
        assert_eq!(Range::parse("1-2").ok(), Some(Range { min: 1, max: 2 }));

        for bad in [
            "", "1", "0-1", "2-1", "1-", "-1", "+1-2", "1-2-3", "1-256", "1-0001",
        ] {
            assert!(Range::parse(bad).is_err(), "{bad}");
        }

        assert_eq!(parse_format("1").ok(), Some(1));

        for bad in ["", "0", "x", "-1", "256", "1000"] {
            assert!(parse_format(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn unknown_features_are_ignored_but_malformed_lists_refused() {
        let parsed = parse_features("checkpoints, full ,someday_maybe").unwrap();

        assert_eq!(
            parsed,
            [Feature::Checkpoints, Feature::Full].into_iter().collect()
        );
        assert!(parse_features("").unwrap().is_empty());
        assert!(parse_features("Checkpoints").is_err());
        assert!(parse_features("full;drop").is_err());
        assert!(parse_features(&"a,".repeat(MAX_FEATURES + 1)).is_err());
        assert!(parse_features(&"a".repeat(MAX_HEADER + 1)).is_err());
        assert!(parse_features(&"a".repeat(MAX_NAME + 1)).is_err());
    }

    #[test]
    fn feature_names_round_trip() {
        for feature in ALL_FEATURES {
            assert_eq!(Feature::parse(feature.name()), Some(feature));
        }

        let value = features_value(&CLIENT_FEATURES);
        let parsed = parse_features(&value).unwrap();

        assert_eq!(parsed, CLIENT_FEATURES.into_iter().collect());
    }

    #[test]
    fn a_client_without_headers_is_served_as_legacy() {
        assert_eq!(Peer::admit(None, None, None), Ok(Peer::legacy()));
        let [(_, protocol), (_, features), (_, format)] = client_headers();
        let current = Peer::admit(Some(&protocol), Some(&features), Some(&format)).unwrap();

        assert!(current.has(Feature::Outdated));
        assert_eq!(current.format, FORMAT);
    }

    #[test]
    fn incompatible_clients_learn_which_side_is_behind() {
        let too_new = Peer::admit(Some("200-201"), None, None);

        assert_eq!(too_new, Err(Refusal::Outdated(Side::Server)));
        let missing = Peer::admit(None, Some("full"), None);

        assert_eq!(missing, Err(Refusal::Outdated(Side::App)));
        assert_eq!(Peer::admit(Some("x"), None, None), Err(Refusal::Invalid));
        assert_eq!(Peer::admit(None, None, Some("0")), Err(Refusal::Invalid));
    }

    #[test]
    fn the_relay_hello_is_accepted_by_this_client() {
        let hello = Hello::relay();
        let offered = hello.offered().unwrap();

        assert_eq!(offered, RELAY_FEATURES.into_iter().collect());
        assert!(!hello.behind());
    }

    #[test]
    fn a_hello_reports_outdated_or_lagging_relays() {
        let mut hello = Hello::relay();

        hello.requires.push("teleport".into());
        assert_eq!(hello.offered(), Err(Refusal::Outdated(Side::App)));
        let mut hello = Hello::relay();

        hello.protocol = Range { min: 200, max: 201 };
        assert_eq!(hello.offered(), Err(Refusal::Outdated(Side::App)));
        let mut hello = Hello::relay();

        hello.features.retain(|name| name != "watch");
        assert!(hello.offered().is_ok());
        assert!(hello.behind());
        let mut hello = Hello::relay();

        hello.protocol = Range { min: 0, max: 1 };
        assert_eq!(hello.offered(), Err(Refusal::Invalid));
        let mut hello = Hello::relay();

        hello.features.push("Bad Name".into());
        assert_eq!(hello.offered(), Err(Refusal::Invalid));
    }

    #[test]
    fn the_shared_format_follows_the_oldest_active_device() {
        assert_eq!(shared_format([]), FORMAT);
        assert_eq!(shared_format([FORMAT, FORMAT]), FORMAT);
        assert_eq!(shared_format([LEGACY_FORMAT]), LEGACY_FORMAT);
        assert_eq!(shared_format([u8::MAX]), FORMAT);
        assert_eq!(shared_format([0]), LEGACY_FORMAT);
    }
}
