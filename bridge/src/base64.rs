//! Standard base64 (RFC 4648) encode and decode. Implemented inline to keep
//! the bridge's dependency set minimal. `encode` serves screenshot bytes
//! (whitepaper section 6.6); `decode` serves agent-supplied asset bytes for
//! `gd_asset_add` (whitepaper section 8).

use crate::protocol::BridgeError;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(triple >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[triple as usize & 0x3f] as char } else { '=' });
    }
    out
}

fn decode_char(c: u8) -> Result<u8, BridgeError> {
    match c {
        b'A'..=b'Z' => Ok(c - b'A'),
        b'a'..=b'z' => Ok(c - b'a' + 26),
        b'0'..=b'9' => Ok(c - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(BridgeError::InvalidArgs(format!("invalid base64 character '{}'", c as char))),
    }
}

pub(crate) fn decode(s: &str) -> Result<Vec<u8>, BridgeError> {
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if !bytes.len().is_multiple_of(4) {
        return Err(BridgeError::InvalidArgs("base64 input length must be a multiple of 4".into()));
    }

    let last_quad_start = bytes.len() - 4;
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (start, quad) in bytes.chunks(4).enumerate().map(|(i, q)| (i * 4, q)) {
        let is_last = start == last_quad_start;
        let pad3 = is_last && quad[3] == b'=';
        let pad2 = is_last && quad[2] == b'=';
        if quad[0] == b'=' || quad[1] == b'=' || (pad2 && !pad3) {
            return Err(BridgeError::InvalidArgs("invalid base64 padding".into()));
        }
        let c0 = decode_char(quad[0])?;
        let c1 = decode_char(quad[1])?;
        let c2 = if pad2 { 0 } else { decode_char(quad[2])? };
        let c3 = if pad3 { 0 } else { decode_char(quad[3])? };
        let triple = ((c0 as u32) << 18) | ((c1 as u32) << 12) | ((c2 as u32) << 6) | (c3 as u32);
        out.push((triple >> 16) as u8);
        if !pad2 {
            out.push((triple >> 8) as u8);
        }
        if !pad3 {
            out.push(triple as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_matches_known_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
        assert_eq!(encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn decode_matches_known_vectors() {
        assert_eq!(decode("").unwrap(), b"");
        assert_eq!(decode("Zg==").unwrap(), b"f");
        assert_eq!(decode("Zm8=").unwrap(), b"fo");
        assert_eq!(decode("Zm9v").unwrap(), b"foo");
        assert_eq!(decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(decode("Zm9vYmE=").unwrap(), b"fooba");
        assert_eq!(decode("Zm9vYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn decode_round_trips_through_encode_for_arbitrary_bytes() {
        let original: Vec<u8> = (0..=255u8).collect();
        assert_eq!(decode(&encode(&original)).unwrap(), original);
    }

    #[test]
    fn decode_rejects_bad_length() {
        assert!(decode("abc").is_err());
    }

    #[test]
    fn decode_rejects_invalid_characters() {
        assert!(decode("ab!*").is_err());
    }
}
