use super::Local;
use super::relay_features::{checkpoints_key, known_format};
use crate::{Error, Socket, Writing, account::Access};

pub(super) struct Link<'a> {
    pub(super) access: &'a Access,
    socket: Option<Socket>,
    pub(super) writing: Writing,
}

impl<'a> Link<'a> {
    pub(super) fn open(local: &impl Local, access: &'a Access) -> Result<Self, Error> {
        let key = checkpoints_key(access);
        let writing = Writing {
            checkpoints: local.with(|store| store.state(&key))?.is_some(),
            format: known_format(local, access)?,
        };

        Ok(Self {
            access,
            socket: None,
            writing,
        })
    }

    pub(super) async fn socket(&mut self) -> Result<&mut Socket, Error> {
        if self.socket.is_none() {
            self.socket = Some(Socket::connect(self.access).await?);
        }

        self.socket.as_mut().ok_or(Error::Network)
    }

    pub(super) fn reset(&mut self) {
        self.socket = None;
    }
}
