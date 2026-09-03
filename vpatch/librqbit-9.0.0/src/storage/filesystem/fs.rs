use std::{
    fs::OpenOptions,
    io::IoSlice,
    path::{Path, PathBuf},
};

use anyhow::Context;
use tracing::warn;

use crate::{
    storage::{StorageFactoryExt, filesystem::opened_file::OurFileExt},
    torrent_state::{ManagedTorrentShared, TorrentMetadata},
};

use crate::storage::{StorageFactory, TorrentStorage};

use super::opened_file::OpenedFile;

#[derive(Default, Clone, Copy)]
pub struct FilesystemStorageFactory {}

impl StorageFactory for FilesystemStorageFactory {
    type Storage = FilesystemStorage;

    fn create(
        &self,
        shared: &ManagedTorrentShared,
        _metadata: &TorrentMetadata,
    ) -> anyhow::Result<FilesystemStorage> {
        Ok(FilesystemStorage {
            output_folder: shared.options.output_folder.clone(),
            opened_files: Default::default(),
        })
    }

    fn clone_box(&self) -> crate::storage::BoxStorageFactory {
        self.boxed()
    }
}

pub struct FilesystemStorage {
    pub(crate) output_folder: PathBuf,
    pub(crate) opened_files: Vec<OpenedFile>,
}

impl FilesystemStorage {
    #[allow(dead_code)]
    pub(crate) fn take_fs(&self) -> anyhow::Result<Self> {
        Ok(Self {
            opened_files: self
                .opened_files
                .iter()
                .map(|f| f.take_clone())
                .collect::<anyhow::Result<Vec<_>>>()?,
            output_folder: self.output_folder.clone(),
        })
    }
}

/// 落盘洗路径（LeLeDownload 定制补丁）：把可能含路径分隔符('/' '\\')、遍历段('..')或
/// Windows 非法字符的文件名洗成安全文件名，避免畸形种子在 Windows 上错误地创建子目录
/// 甚至越界写出。逐组件处理：`..`/`.`/根前缀等越界组件直接丢弃，普通组件内的非法字符
/// 替换为 '_'。info_hash 由 raw_bytes 派生，与此处改名无关。
fn sanitize_relative_filename(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(c) => {
                let cleaned: String = c
                    .to_string_lossy()
                    .chars()
                    .map(|ch| match ch {
                        '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                        _ => ch,
                    })
                    .collect();
                out.push(cleaned);
            }
            // 归一化越界组件：Prefix/Root/CurDir/ParentDir 一律丢弃，保持相对落盘
            Component::Prefix(_) | Component::RootDir | Component::CurDir | Component::ParentDir => {}
        }
    }
    if out.as_os_str().is_empty() {
        out.push("file");
    }
    out
}

impl TorrentStorage for FilesystemStorage {
    fn pread_exact(&self, file_id: usize, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        self.opened_files
            .get(file_id)
            .context("no such file")?
            .lock_read()?
            .pread_exact(offset, buf)
    }

    fn pwrite_all(&self, file_id: usize, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        let of = self.opened_files.get(file_id).context("no such file")?;
        #[cfg(windows)]
        return of.try_mark_sparse()?.pwrite_all(offset, buf);
        #[cfg(not(windows))]
        return of.lock_read()?.pwrite_all(offset, buf);
    }

    fn pwrite_all_vectored(
        &self,
        file_id: usize,
        offset: u64,
        bufs: [IoSlice<'_>; 2],
    ) -> anyhow::Result<usize> {
        let of = self.opened_files.get(file_id).context("no such file")?;
        #[cfg(windows)]
        return of.try_mark_sparse()?.pwrite_all_vectored(offset, bufs);
        #[cfg(not(windows))]
        return of.lock_read()?.pwrite_all_vectored(offset, bufs);
    }

    fn remove_file(&self, _file_id: usize, filename: &Path) -> anyhow::Result<()> {
        Ok(std::fs::remove_file(self.output_folder.join(filename))?)
    }

    fn ensure_file_length(&self, file_id: usize, len: u64) -> anyhow::Result<()> {
        let f = &self.opened_files.get(file_id).context("no such file")?;
        #[cfg(windows)]
        f.try_mark_sparse()?;
        Ok(f.lock_read()?.set_len(len)?)
    }

    fn take(&self) -> anyhow::Result<Box<dyn TorrentStorage>> {
        Ok(Box::new(Self {
            opened_files: self
                .opened_files
                .iter()
                .map(|f| f.take_clone())
                .collect::<anyhow::Result<Vec<_>>>()?,
            output_folder: self.output_folder.clone(),
        }))
    }

    fn remove_directory_if_empty(&self, path: &Path) -> anyhow::Result<()> {
        let path = self.output_folder.join(path);
        if !path.is_dir() {
            anyhow::bail!("cannot remove dir: {path:?} is not a directory")
        }
        if std::fs::read_dir(&path)?.count() == 0 {
            std::fs::remove_dir(&path).with_context(|| format!("error removing {path:?}"))
        } else {
            warn!("did not remove {path:?} as it was not empty");
            Ok(())
        }
    }

    fn init(
        &mut self,
        shared: &ManagedTorrentShared,
        metadata: &TorrentMetadata,
    ) -> anyhow::Result<()> {
        let mut files = Vec::<OpenedFile>::new();
        for file_details in metadata.file_infos.iter() {
            let mut full_path = self.output_folder.clone();
            let relative_path = &file_details.relative_filename;
            // 落盘洗路径（LeLeDownload 定制补丁）：畸形种子文件名可能含路径分隔符('/' '\\')
            // 或遍历段('..')，直接 push 会在 Windows 上错误地创建子目录甚至越界写出。
            // 统一在此洗成安全字符，既保全盘可下载，又不影响 info_hash（由 raw_bytes 派生）。
            let safe_relative = sanitize_relative_filename(relative_path);
            full_path.push(&safe_relative);

            if file_details.attrs.padding {
                files.push(OpenedFile::new_dummy());
                continue;
            };
            std::fs::create_dir_all(full_path.parent().context("bug: no parent")?)?;
            let f = if shared.options.allow_overwrite {
                OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(&full_path)
                    .with_context(|| format!("error opening {full_path:?} in read/write mode"))?
            } else {
                // create_new does not seem to work with read(true), so calling this twice.
                OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&full_path)
                    .with_context(|| {
                        format!(
                            "error creating a new file (because allow_overwrite = false) {:?}",
                            full_path
                        )
                    })?;
                OpenOptions::new().read(true).write(true).open(&full_path)?
            };
            files.push(OpenedFile::new(full_path.clone(), f));
        }

        self.opened_files = files;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn sanitize_preserves_clean_structure() {
        let p = Path::new("movie/sub/video.mp4");
        let out = sanitize_relative_filename(p);
        let s = out.to_string_lossy().replace('\\', "/");
        assert_eq!(s, "movie/sub/video.mp4");
    }

    #[test]
    fn sanitize_strips_traversal_and_illegal_chars() {
        // 模拟畸形种子：路径数组单元素内嵌 '/' 与 ':'（librqbit 会按 '/' 拆成多组件）
        let p = Path::new("root/ad/http://evil/a/b.url");
        let out = sanitize_relative_filename(p);
        let s = out.to_string_lossy().replace('\\', "/");
        assert!(!s.contains(".."), "不得含路径穿越段: {s}");
        assert!(!s.contains(':'), "':' 须被洗成 '_': {s}");
        assert!(
            !s.contains('*')
                && !s.contains('?')
                && !s.contains('"')
                && !s.contains('<')
                && !s.contains('>')
                && !s.contains('|'),
            "不得含 Windows 非法字符: {s}"
        );
        assert!(s.ends_with("b.url"), "扩展名须保留: {s}");
    }

    #[test]
    fn sanitize_empty_becomes_file() {
        let p = Path::new("");
        let out = sanitize_relative_filename(p);
        assert_eq!(out.to_string_lossy(), "file");
    }
}
