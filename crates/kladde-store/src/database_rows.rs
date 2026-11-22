use crate::{Error, Store, uuid_col};
use rusqlite::params;
use uuid::Uuid;

pub type RowRecord = (i64, Uuid, String, String);
pub type RowChange = (i64, Uuid, String, String, bool);
pub const ROW_PAGE: i64 = 5000;

fn row_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<RowRecord> {
    Ok((row.get(0)?, uuid_col(row, 1)?, row.get(2)?, row.get(3)?))
}

impl Store {
    pub fn rows_page(
        &self,
        space: Uuid,
        parent: Uuid,
        after: i64,
    ) -> Result<Vec<RowRecord>, Error> {
        Ok(self.0.prepare("SELECT rowid,id,title,props FROM notes WHERE space=?1 AND parent=?2 AND kind='row' AND archived=0 AND rowid>?3 ORDER BY rowid LIMIT ?4")?.query_map(params![space.to_string(),parent.to_string(),after,ROW_PAGE],row_record)?.collect::<Result<_,_>>()?)
    }

    pub fn rows_changed(
        &self,
        space: Uuid,
        parent: Uuid,
        after: i64,
    ) -> Result<Vec<RowChange>, Error> {
        Ok(self.0.prepare("SELECT m.mark,m.id,COALESCE(n.title,''),COALESCE(n.props,'{}'),m.gone OR n.id IS NULL OR n.archived FROM row_marks m LEFT JOIN notes n ON n.id=m.id AND n.space=?1 AND n.kind='row' WHERE m.parent=?2 AND m.mark>?3 ORDER BY m.mark LIMIT ?4")?.query_map(params![space.to_string(),parent.to_string(),after,ROW_PAGE],|r|Ok((r.get(0)?,uuid_col(r,1)?,r.get(2)?,r.get(3)?,r.get(4)?)))?.collect::<Result<_,_>>()?)
    }

    pub fn row_mark(&self) -> Result<i64, Error> {
        Ok(self
            .0
            .query_row("SELECT mark FROM row_clock", [], |r| r.get(0))?)
    }
}
