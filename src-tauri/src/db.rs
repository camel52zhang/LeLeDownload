// Database - SQLite存储下载记录
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::download::{DownloadStatus, DownloadTask};

pub struct Database {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadRecord {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub total_size: i64,
    pub downloaded_size: i64,
    pub speed: f64,
    pub status: String,
    pub progress: f64,
    pub thread_count: i32,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub save_path: String,
}

impl From<DownloadTask> for DownloadRecord {
    fn from(task: DownloadTask) -> Self {
        Self {
            id: task.id,
            url: task.url,
            filename: task.filename,
            total_size: task.total_size as i64,
            downloaded_size: task.downloaded_size as i64,
            speed: task.speed,
            status: match task.status {
                DownloadStatus::Pending => "pending",
                DownloadStatus::Downloading => "downloading",
                DownloadStatus::Paused => "paused",
                DownloadStatus::Completed => "completed",
                DownloadStatus::Failed => "failed",
            }.to_string(),
            progress: task.progress,
            thread_count: task.thread_count as i32,
            created_at: task.created_at,
            completed_at: task.completed_at,
            error: task.error,
            save_path: task.save_path,
        }
    }
}

impl Database {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let db_path = Self::get_db_path()?;

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS downloads (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                filename TEXT NOT NULL,
                total_size INTEGER DEFAULT 0,
                downloaded_size INTEGER DEFAULT 0,
                speed REAL DEFAULT 0,
                status TEXT DEFAULT 'pending',
                progress REAL DEFAULT 0,
                thread_count INTEGER DEFAULT 8,
                created_at TEXT NOT NULL,
                completed_at TEXT,
                error TEXT,
                save_path TEXT NOT NULL
            )",
            [],
        )?;

        tracing::info!("Database initialized at: {:?}", db_path);

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn get_db_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
        let data_dir = dirs::data_local_dir()
            .ok_or("Cannot find local data directory")?;

        Ok(data_dir.join("lele_download").join("downloads.db"))
    }

    pub fn insert_task(&self, task: &DownloadTask) -> Result<(), String> {
        let record = DownloadRecord::from(task.clone());
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO downloads
             (id, url, filename, total_size, downloaded_size, speed, status, progress, thread_count, created_at, completed_at, error, save_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                record.id, record.url, record.filename,
                record.total_size, record.downloaded_size, record.speed,
                record.status, record.progress, record.thread_count,
                record.created_at, record.completed_at, record.error, record.save_path,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_task(&self, task: &DownloadTask) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE downloads SET
                total_size = ?2, downloaded_size = ?3, speed = ?4,
                status = ?5, progress = ?6, completed_at = ?7, error = ?8
             WHERE id = ?1",
            rusqlite::params![
                task.id, task.total_size as i64, task.downloaded_size as i64,
                task.speed,
                match task.status {
                    DownloadStatus::Pending => "pending",
                    DownloadStatus::Downloading => "downloading",
                    DownloadStatus::Paused => "paused",
                    DownloadStatus::Completed => "completed",
                    DownloadStatus::Failed => "failed",
                },
                task.progress, task.completed_at, task.error,
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_tasks(&self) -> Result<Vec<DownloadTask>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, url, filename, total_size, downloaded_size, speed, status, progress, thread_count, created_at, completed_at, error, save_path FROM downloads"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            Ok(DownloadTask {
                id: row.get(0)?,
                url: row.get(1)?,
                filename: row.get(2)?,
                total_size: row.get::<_, i64>(3)? as u64,
                downloaded_size: row.get::<_, i64>(4)? as u64,
                speed: row.get(5)?,
                status: match row.get::<_, String>(6)?.as_str() {
                    "downloading" => DownloadStatus::Downloading,
                    "paused" => DownloadStatus::Paused,
                    "completed" => DownloadStatus::Completed,
                    "failed" => DownloadStatus::Failed,
                    _ => DownloadStatus::Pending,
                },
                progress: row.get(7)?,
                thread_count: row.get::<_, i32>(8)? as usize,
                retry_count: 0,
                max_retries: 3,
                created_at: row.get(9)?,
                completed_at: row.get(10)?,
                error: row.get(11)?,
                save_path: row.get(12)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut tasks = Vec::new();
        for row in rows {
            match row {
                Ok(task) => tasks.push(task),
                Err(e) => tracing::warn!("Failed to load task from db: {}", e),
            }
        }
        Ok(tasks)
    }

    pub fn delete_task(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM downloads WHERE id = ?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clear_completed(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM downloads WHERE status = 'completed'", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
