use axum::body::Body;
use futures_util::StreamExt;
use std::{collections::HashSet, io, path::PathBuf};
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

const UNFINISHED: &str = ".writing";

pub struct Staged {
    path: PathBuf,
    pub size: usize,
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

pub trait BlobStorage {
    async fn stage(&self, account: Uuid, body: Body, limit: usize) -> io::Result<Staged>;

    async fn keep(&self, staged: &Staged, account: Uuid, id: Uuid) -> io::Result<()>;

    async fn open(&self, account: Uuid, id: Uuid) -> io::Result<(fs::File, u64)>;

    async fn exists(&self, account: Uuid, id: Uuid) -> io::Result<bool>;

    async fn stored(&self, account: Uuid) -> io::Result<HashSet<Uuid>>;

    async fn erase_file(&self, account: Uuid, id: Uuid) -> io::Result<()>;

    async fn erase_account(&self, account: Uuid) -> io::Result<()>;

    async fn accounts(&self) -> io::Result<Vec<Uuid>>;

    async fn erase_unfinished(&self) -> io::Result<()>;
}

pub struct Volume(pub PathBuf);

impl BlobStorage for Volume {
    async fn stage(&self, account: Uuid, body: Body, limit: usize) -> io::Result<Staged> {
        let directory = self.0.join(account.to_string());

        fs::create_dir_all(&directory).await?;
        let mut staged = Staged {
            path: directory.join(format!("{}{UNFINISHED}", Uuid::new_v4())),
            size: 0,
        };

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged.path)
            .await?;
        let mut chunks = body.into_data_stream();

        while let Some(chunk) = chunks.next().await {
            let chunk = chunk.map_err(io::Error::other)?;

            staged.size += chunk.len();

            if staged.size > limit {
                return Err(io::ErrorKind::FileTooLarge.into());
            }

            file.write_all(&chunk).await?;
        }

        file.sync_all().await?;

        Ok(staged)
    }

    async fn keep(&self, staged: &Staged, account: Uuid, id: Uuid) -> io::Result<()> {
        let directory = self.0.join(account.to_string());

        fs::rename(&staged.path, directory.join(id.to_string())).await
    }

    async fn open(&self, account: Uuid, id: Uuid) -> io::Result<(fs::File, u64)> {
        let file = fs::File::open(self.0.join(account.to_string()).join(id.to_string())).await?;
        let size = file.metadata().await?.len();

        Ok((file, size))
    }

    async fn exists(&self, account: Uuid, id: Uuid) -> io::Result<bool> {
        fs::try_exists(self.0.join(account.to_string()).join(id.to_string())).await
    }

    async fn stored(&self, account: Uuid) -> io::Result<HashSet<Uuid>> {
        let mut found = HashSet::new();
        let mut entries = match fs::read_dir(self.0.join(account.to_string())).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(found),
            entries => entries?,
        };

        while let Some(entry) = entries.next_entry().await? {
            if let Some(id) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
                found.insert(id);
            }
        }

        Ok(found)
    }

    async fn erase_file(&self, account: Uuid, id: Uuid) -> io::Result<()> {
        match fs::remove_file(self.0.join(account.to_string()).join(id.to_string())).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    }

    async fn erase_account(&self, account: Uuid) -> io::Result<()> {
        match fs::remove_dir_all(self.0.join(account.to_string())).await {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    async fn accounts(&self) -> io::Result<Vec<Uuid>> {
        let mut found = Vec::new();
        let mut entries = fs::read_dir(&self.0).await?;

        while let Some(entry) = entries.next_entry().await? {
            if let Some(account) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
                found.push(account);
            }
        }

        Ok(found)
    }

    async fn erase_unfinished(&self) -> io::Result<()> {
        for account in self.accounts().await? {
            let mut entries = fs::read_dir(self.0.join(account.to_string())).await?;

            while let Some(entry) = entries.next_entry().await? {
                if entry.file_name().to_string_lossy().ends_with(UNFINISHED) {
                    fs::remove_file(entry.path()).await?;
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn volume() -> (tempfile::TempDir, Volume) {
        let dir = tempfile::tempdir().unwrap();
        let volume = Volume(dir.path().to_path_buf());

        (dir, volume)
    }

    fn files(volume: &Volume, account: Uuid) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(volume.0.join(account.to_string()))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();

        names
    }

    #[tokio::test]
    async fn a_kept_upload_lands_under_its_id_and_reads_back() {
        let (_dir, volume) = volume();
        let (account, id) = (Uuid::new_v4(), Uuid::new_v4());
        let staged = volume
            .stage(account, Body::from(vec![7u8; 100_000]), 100_000)
            .await
            .unwrap();
        assert_eq!(staged.size, 100_000);
        volume.keep(&staged, account, id).await.unwrap();
        drop(staged);
        assert_eq!(files(&volume, account), vec![id.to_string()]);
        let (mut file, size) = volume.open(account, id).await.unwrap();
        let mut read = Vec::new();

        tokio::io::AsyncReadExt::read_to_end(&mut file, &mut read)
            .await
            .unwrap();
        assert_eq!((size, read), (100_000, vec![7u8; 100_000]));
    }

    #[tokio::test]
    async fn an_oversized_or_dropped_upload_leaves_no_file() {
        let (_dir, volume) = volume();
        let account = Uuid::new_v4();
        let refused = volume.stage(account, Body::from(vec![1u8; 33]), 32).await;

        assert_eq!(
            refused.err().map(|e| e.kind()),
            Some(io::ErrorKind::FileTooLarge)
        );
        let abandoned = volume
            .stage(account, Body::from(vec![1u8; 16]), 32)
            .await
            .unwrap();
        assert_eq!(files(&volume, account).len(), 1);
        drop(abandoned);
        assert!(files(&volume, account).is_empty());
    }

    #[tokio::test]
    async fn unfinished_uploads_are_erased_and_stored_blobs_stay() {
        let (_dir, volume) = volume();
        let (account, id) = (Uuid::new_v4(), Uuid::new_v4());
        let directory = volume.0.join(account.to_string());

        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(id.to_string()), b"stored").unwrap();
        std::fs::write(
            directory.join(format!("{}{UNFINISHED}", Uuid::new_v4())),
            b"cut",
        )
        .unwrap();
        volume.erase_unfinished().await.unwrap();
        assert_eq!(files(&volume, account), vec![id.to_string()]);
    }
}
