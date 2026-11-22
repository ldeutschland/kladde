use crate::{Invalid, Key, random};
use chacha20poly1305::{
    XChaCha20Poly1305,
    aead::stream::{DecryptorBE32, EncryptorBE32},
};

use serde::{
    Deserialize, Deserializer, Serialize,
    de::{Error, SeqAccess, Visitor},
};

use zeroize::Zeroizing;

pub const CHUNK: usize = 65536;
const MAX_CHUNKS: usize = kladde_protocol::MAX_ATTACHMENT_BYTES.div_ceil(CHUNK);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    version: u8,
    nonce: [u8; 19],
    #[serde(deserialize_with = "read_chunks")]
    chunks: Vec<Vec<u8>>,
}

fn read_chunks<'de, D: Deserializer<'de>>(decoder: D) -> Result<Vec<Vec<u8>>, D::Error> {
    struct FileChunks;

    impl<'de> Visitor<'de> for FileChunks {
        type Value = Vec<Vec<u8>>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a bounded sequence of encrypted file chunks")
        }

        fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> Result<Self::Value, S::Error> {
            if seq.size_hint().is_some_and(|n| n > MAX_CHUNKS) {
                return Err(S::Error::custom("Too many file chunks"));
            }

            let mut chunks = Vec::new();

            while let Some(bytes) = seq.next_element::<serde_bytes::ByteBuf>()? {
                if chunks.len() == MAX_CHUNKS || !(16..=CHUNK + 16).contains(&bytes.len()) {
                    return Err(S::Error::custom("Invalid file chunk"));
                }

                chunks.push(bytes.into_vec());
            }

            Ok(chunks)
        }
    }

    decoder.deserialize_seq(FileChunks)
}

pub fn encrypt(key: &Key, data: &[u8]) -> Result<File, Invalid> {
    if data.len() > kladde_protocol::MAX_ATTACHMENT_BYTES {
        return Err(Invalid);
    }

    let nonce = random();
    let mut stream = EncryptorBE32::<XChaCha20Poly1305>::new(key.as_ref().into(), (&nonce).into());
    let mut chunks = Vec::new();
    let mut rest = data;

    while rest.len() > CHUNK {
        chunks.push(stream.encrypt_next(&rest[..CHUNK]).map_err(|_| Invalid)?);

        rest = &rest[CHUNK..]
    }

    chunks.push(stream.encrypt_last(rest).map_err(|_| Invalid)?);

    Ok(File {
        version: 1,
        nonce,
        chunks,
    })
}

pub fn decrypt(key: &Key, file: &File) -> Result<Zeroizing<Vec<u8>>, Invalid> {
    if file.version != 1 || file.chunks.len() > MAX_CHUNKS {
        return Err(Invalid);
    }

    let (last, rest) = file.chunks.split_last().ok_or(Invalid)?;
    let mut out = Zeroizing::new(Vec::new());
    let mut stream =
        DecryptorBE32::<XChaCha20Poly1305>::new(key.as_ref().into(), (&file.nonce).into());
    for c in rest {
        if c.len() != CHUNK + 16 {
            return Err(Invalid);
        }

        out.extend_from_slice(&Zeroizing::new(
            stream.decrypt_next(c.as_slice()).map_err(|_| Invalid)?,
        ))
    }

    if last.len() > CHUNK + 16 {
        return Err(Invalid);
    }

    out.extend_from_slice(&Zeroizing::new(
        stream.decrypt_last(last.as_slice()).map_err(|_| Invalid)?,
    ));

    Ok(out)
}
