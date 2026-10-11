//! Open the parent folder of an already authorized local file on Linux.
//! xdg-open is supplied by the Debian package's xdg-utils dependency.
use std::{path::Path, process::Command};

pub fn command(file: &Path) -> Result<Command, String> {
    // A canonical absolute path cannot be interpreted as an option or a URI.
    // Never send the file itself to xdg-open: that could launch its handler.
    let file = file.canonicalize().map_err(|e| e.to_string())?;
    if !file.is_file() {
        return Err("File no longer exists".into());
    }
    let parent = file.parent().filter(|p| p.is_dir())
        .ok_or_else(|| "File has no existing parent folder".to_string())?;
    let mut command = Command::new("xdg-open");
    command.arg(parent);
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn only_existing_file_parent_is_passed_as_one_literal_argument() {
        let root = std::env::temp_dir().join(format!("fairbeam-reveal-{}-{}",
            std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        // Include shell syntax and non-ASCII text without launching any process.
        let folder = root.join("-option ; $(literal) Türkçe");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("result.html");
        fs::write(&file, "fixture").unwrap();
        let opener = command(&file).unwrap();
        assert_eq!(opener.get_program(), "xdg-open");
        let args: Vec<_> = opener.get_args().collect();
        assert_eq!(args, vec![folder.canonicalize().unwrap().as_os_str()]);
        assert!(command(&folder).is_err(), "do not accept directories as files");
        fs::remove_file(&file).unwrap();
        assert!(command(&file).is_err(), "deleted files must not open a folder");
        fs::remove_dir_all(&root).unwrap();
    }
}
