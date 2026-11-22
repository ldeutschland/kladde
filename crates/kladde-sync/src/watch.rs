use crate::{Error, Socket, account::Access, socket::Heard};
use kladde_protocol::{Client, Server};
use std::time::{Duration, Instant};
use uuid::Uuid;

const PING_EVERY: Duration = Duration::from_secs(20);
const SILENCE_LIMIT: Duration = Duration::from_secs(65);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    Changed { doc: Uuid, seq: i64 },
    Removed(Uuid),
}

pub struct Watch {
    socket: Socket,
    space: Uuid,
    heard: Instant,
}

impl Watch {
    pub async fn open(access: &Access) -> Result<Self, Error> {
        let mut socket = Socket::connect(access).await?;

        socket
            .send(&Client::Watch {
                space: access.space,
            })
            .await?;

        match socket.receive().await? {
            Server::Watching { space } if space == access.space => Ok(Self {
                socket,
                space: access.space,
                heard: Instant::now(),
            }),
            _ => Err(Error::Conflict),
        }
    }

    pub async fn next(&mut self) -> Result<Notice, Error> {
        loop {
            if self.heard.elapsed() > SILENCE_LIMIT {
                return Err(Error::Network);
            }

            let message = match self.socket.listen(PING_EVERY).await? {
                Heard::Nothing => {
                    self.socket.ping().await?;
                    continue;
                }
                Heard::Alive => None,
                Heard::Message(message) => Some(*message),
            };

            self.heard = Instant::now();

            if let Some(notice) = message.map(|m| self.notice(m)).transpose()?.flatten() {
                return Ok(notice);
            }
        }
    }

    fn notice(&self, message: Server) -> Result<Option<Notice>, Error> {
        match message {
            Server::Changed { space, doc, seq } if space == self.space => {
                Ok(Some(Notice::Changed { doc, seq }))
            }
            Server::Removed { space, doc } if space == self.space => Ok(Some(Notice::Removed(doc))),
            Server::Ephemeral(_) => Ok(None),
            _ => Err(Error::Conflict),
        }
    }
}
