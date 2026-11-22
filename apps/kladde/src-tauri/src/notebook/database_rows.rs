use crate::notebook::vault::Vault;
use tauri::{AppHandle, State};
use uuid::Uuid;

type RowPage = (Vec<(Uuid, String, String)>, Option<i64>, i64);

type RowChanges = (Vec<(Uuid, String, String, bool)>, Option<i64>, i64);

fn row_page(records: Vec<kladde_store::RowRecord>, mark: i64) -> RowPage {
    let full = records.len() as i64 == kladde_store::ROW_PAGE;
    let next = records.last().map(|(position, ..)| *position);
    let rows = records
        .into_iter()
        .map(|(_, id, title, props)| (id, title, props));
    (rows.collect(), next.filter(|_| full), mark)
}

fn row_changes(records: Vec<kladde_store::RowChange>, since: i64) -> RowChanges {
    let full = records.len() as i64 == kladde_store::ROW_PAGE;
    let mark = records.last().map_or(since, |(mark, ..)| *mark);
    let rows = records
        .into_iter()
        .map(|(_, id, title, props, gone)| (id, title, props, gone));
    (rows.collect(), full.then_some(mark), mark)
}

#[tauri::command]
pub fn rows(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    parent: Uuid,
    after: Option<i64>,
) -> Result<RowPage, String> {
    vault.access(&app, |store| {
        let mark = store.row_mark()?;
        let records = store.rows_page(space, parent, after.unwrap_or(0))?;

        Ok(row_page(records, mark))
    })
}

#[tauri::command]
pub fn rows_changed(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    parent: Uuid,
    since: i64,
) -> Result<RowChanges, String> {
    vault.access(&app, |store| {
        Ok(row_changes(
            store.rows_changed(space, parent, since)?,
            since,
        ))
    })
}
