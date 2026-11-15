use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::process;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 4 {
        return Err("usage: raven-signature-verify <artifact> <signature> <public-key>".into());
    }
    verify(Path::new(&args[1]), &args[2], &args[3])?;
    println!("{{\"verified\":true}}");
    Ok(())
}

/// Checks the artifact against the signature file and the public key (a file or the key
/// itself). Only prehashed (Tauri's) signatures are accepted.
fn verify(artifact_path: &Path, signature: &str, public_key: &str) -> Result<(), String> {
    let signature = load_signature(signature)?;
    let public_key = load_public_key(public_key)?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| "signature is incompatible with the public key".to_string())?;
    let mut artifact =
        File::open(artifact_path).map_err(|_| "artifact file could not be opened".to_string())?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = artifact
            .read(&mut buffer)
            .map_err(|_| "artifact file could not be read".to_string())?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier
        .finalize()
        .map_err(|_| "artifact signature verification failed".to_string())?;
    Ok(())
}

fn load_public_key(value: &str) -> Result<PublicKey, String> {
    let content = if Path::new(value).is_file() {
        fs::read_to_string(value).map_err(|_| "public key file could not be read".to_string())?
    } else {
        value.to_string()
    };
    let trimmed = content.trim();
    if trimmed.contains('\n') || trimmed.contains('\r') {
        return PublicKey::decode(trimmed).map_err(|_| "public key is invalid".to_string());
    }
    if let Ok(key) = PublicKey::from_base64(trimmed) {
        return Ok(key);
    }
    let decoded = STANDARD
        .decode(trimmed)
        .map_err(|_| "public key is invalid".to_string())?;
    let text = String::from_utf8(decoded).map_err(|_| "public key is invalid".to_string())?;
    PublicKey::decode(text.trim()).map_err(|_| "public key is invalid".to_string())
}

fn load_signature(value: &str) -> Result<Signature, String> {
    let content =
        fs::read_to_string(value).map_err(|_| "signature file could not be read".to_string())?;
    let trimmed = content.trim();
    if let Ok(signature) = Signature::decode(trimmed) {
        return Ok(signature);
    }
    let decoded = STANDARD
        .decode(trimmed)
        .map_err(|_| "signature file is invalid".to_string())?;
    let text = String::from_utf8(decoded).map_err(|_| "signature file is invalid".to_string())?;
    Signature::decode(text.trim()).map_err(|_| "signature file is invalid".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Test vectors from minisign-verify 0.3.0's own tests: a key and its signatures of the
    // four bytes "test".
    const KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const KEY_FILE: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    // Prehashed (BLAKE2b, "ED"): what minisign and Tauri's signer write now.
    const PREHASHED: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    // Legacy ("Ed", the whole file signed directly). The verifier streams, so it refuses these.
    const LEGACY: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";

    fn temp(contents: &[u8]) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let path = env::temp_dir().join(format!(
            "raven-signature-verify-{}-{}",
            process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::write(&path, contents).unwrap();
        path
    }

    fn check(artifact: &[u8], signature: &str, key: &str) -> Result<(), String> {
        let artifact = temp(artifact);
        let signature = temp(signature.as_bytes());
        let result = verify(&artifact, signature.to_str().unwrap(), key);
        let _ = fs::remove_file(artifact);
        let _ = fs::remove_file(signature);
        result
    }

    /// A key with the same id as KEY but other key bytes, and one with another id.
    fn other_key(same_id: bool) -> String {
        let mut bin = STANDARD.decode(KEY).unwrap();
        if !same_id {
            bin[2] ^= 1;
        }
        bin[10] ^= 1;
        STANDARD.encode(bin)
    }

    #[test]
    fn accepts_a_good_signature_in_every_encoding() {
        check(b"test", PREHASHED, KEY).expect("plain key, plain signature");
        // Tauri writes both the .sig and the key as base64 of the minisign text.
        check(
            b"test",
            &STANDARD.encode(PREHASHED),
            &STANDARD.encode(KEY_FILE),
        )
        .expect("base64 key and signature");
        let key_file = temp(KEY_FILE.as_bytes());
        let result = check(b"test", PREHASHED, key_file.to_str().unwrap());
        let _ = fs::remove_file(&key_file);
        result.expect("key file");
    }

    #[test]
    fn refuses_a_tampered_artifact() {
        assert_eq!(
            check(b"Test", PREHASHED, KEY),
            Err("artifact signature verification failed".into())
        );
        assert!(check(b"test\n", PREHASHED, KEY).is_err());
        assert!(check(b"", PREHASHED, KEY).is_err());
    }

    #[test]
    fn refuses_the_wrong_key() {
        assert!(check(b"test", PREHASHED, &other_key(true)).is_err());
        assert_eq!(
            check(b"test", PREHASHED, &other_key(false)),
            Err("signature is incompatible with the public key".into())
        );
    }

    #[test]
    fn refuses_a_legacy_signature() {
        assert_eq!(
            check(b"test", LEGACY, KEY),
            Err("signature is incompatible with the public key".into())
        );
    }

    #[test]
    fn refuses_a_tampered_trusted_comment() {
        let tampered = PREHASHED.replace("file:test", "file:tesT");
        assert!(check(b"test", &tampered, KEY).is_err());
    }

    #[test]
    fn refuses_garbage_and_missing_files() {
        assert!(check(b"test", "not a signature", KEY).is_err());
        assert!(check(b"test", PREHASHED, "not a key").is_err());
        assert_eq!(
            verify(
                Path::new("/nonexistent/raven-artifact"),
                "/nonexistent/sig",
                KEY
            ),
            Err("signature file could not be read".into())
        );
    }
}
