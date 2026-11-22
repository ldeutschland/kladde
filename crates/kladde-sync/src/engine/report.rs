use super::Local;
use crate::Error;
use kladde_protocol::compat::Side;
use serde::Serialize;
use uuid::Uuid;

pub fn error_code(error: &Error) -> &'static str {
    match error {
        Error::Network => "offline",
        Error::Busy => "busy",
        Error::Auth => "auth",
        Error::Denied => "denied",
        Error::Storage => "storage",
        Error::Url => "address",
        Error::Full => "full",
        Error::Outdated(Side::App) | Error::Newer => "outdated_app",
        Error::Outdated(Side::Server) => "outdated_server",
        Error::Conflict
        | Error::Stale
        | Error::Unreadable
        | Error::Crypto(_)
        | Error::Protocol(_) => "integrity",
    }
}

#[derive(Default, Serialize)]
pub struct Report {
    pub changed: Vec<Uuid>,
    pub removed: Vec<Uuid>,
    pub rescue: Vec<Uuid>,
    pub failed: Vec<Uuid>,
    pub retry: Vec<Uuid>,
    pub newer: Vec<Uuid>,
    pub damaged: Vec<Uuid>,
    pub behind: Option<Vec<&'static str>>,
    pub waiting: usize,
    pub stopped: Option<&'static str>,
}

pub(super) fn report_changed(local: &impl Local, report: &mut Report, id: Uuid) {
    report.changed.push(id);
    local.changed(id);
}

pub(super) fn report_newer_format(local: &impl Local, report: &mut Report, id: Uuid) {
    report_changed(local, report, id);
    report.failed.push(id);
    report.newer.push(id);
}

pub(super) fn report_damaged(report: &mut Report, id: Uuid) {
    report.failed.push(id);
    report.damaged.push(id);
}

pub(super) fn stop_for_full_storage(report: &mut Report, id: Uuid) {
    report.failed.push(id);
    report.stopped.get_or_insert(error_code(&Error::Full));
}
