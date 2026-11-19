//! 本地曲库（桌面版）：扫描用户添加的文件夹 / 文件并读取标签；
//! 通过自定义协议提供音频流（media，支持 Range 以便拖动进度）与内嵌封面（cover）。
//! 两个协议都只放行"已添加路径"之内的音频文件，并带 CORS 头，让频谱分析与封面取色可用。

use lofty::prelude::*;
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{Request, Response, StatusCode, header};

const AUDIO_EXT: [&str; 9] = ["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "webm"];
const CHUNK: u64 = 4 * 1024 * 1024; // 单次 Range 最多返回 4 MB

#[derive(Default)]
pub struct Library {
    roots: Mutex<Vec<PathBuf>>, // 已添加的文件夹 / 文件（规范化后）
}

#[derive(Serialize)]
pub struct LocalTrack {
    path: String,
    title: String,
    artist: String,
    album: String,
    dur: f64,
    cover: bool,
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}
fn is_audio(p: &Path) -> bool {
    AUDIO_EXT.contains(&ext_of(p).as_str())
}

fn walk(p: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    if p.is_dir() {
        if depth > 16 {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                walk(&e.path(), out, depth + 1);
            }
        }
    } else if is_audio(p) {
        out.push(p.to_path_buf());
    }
}

fn read_track(p: &Path) -> LocalTrack {
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    // 无标签时：文件名 "歌手 - 歌名"
    let (artist, title) = match stem.split_once(" - ") {
        Some((a, t)) => (a.trim().to_string(), t.trim().to_string()),
        None => ("本地音乐".to_string(), stem.clone()),
    };
    let mut tr = LocalTrack { path: p.to_string_lossy().into_owned(), title, artist, album: String::new(), dur: 0.0, cover: false };
    if let Ok(f) = lofty::read_from_path(p) {
        tr.dur = f.properties().duration().as_secs_f64();
        if let Some(tag) = f.primary_tag().or_else(|| f.first_tag()) {
            let pick = |v: Option<std::borrow::Cow<'_, str>>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            if let Some(t) = pick(tag.title()) { tr.title = t }
            if let Some(a) = pick(tag.artist()) { tr.artist = a }
            if let Some(al) = pick(tag.album()) { tr.album = al }
            tr.cover = !tag.pictures().is_empty();
        }
    }
    tr
}

/// 从 http://media.localhost/<encodeURIComponent(path)> 还原文件路径
fn path_of(req: &Request<Vec<u8>>) -> PathBuf {
    let raw = req.uri().path().trim_start_matches('/');
    PathBuf::from(percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned())
}

fn reply(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

impl Library {
    /// 扫描全部已添加路径（每次都以前端传来的完整列表为准）
    pub fn scan(&self, paths: Vec<String>) -> Vec<LocalTrack> {
        let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).filter(|p| p.exists()).collect();
        let mut files = Vec::new();
        for r in &roots {
            walk(r, &mut files, 0);
        }
        files.sort();
        files.dedup();
        *self.roots.lock().unwrap() = roots.iter().filter_map(|r| r.canonicalize().ok()).collect();
        files.iter().map(|f| read_track(f)).collect()
    }

    /// 只放行已添加路径之内的音频文件
    fn allowed(&self, p: &Path) -> Option<PathBuf> {
        let c = p.canonicalize().ok()?;
        (is_audio(&c) && self.roots.lock().unwrap().iter().any(|r| c.starts_with(r))).then_some(c)
    }

    pub fn media(&self, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let Some(path) = self.allowed(&path_of(req)) else { return reply(StatusCode::FORBIDDEN, "text/plain", vec![]) };
        let Ok(mut f) = File::open(&path) else { return reply(StatusCode::NOT_FOUND, "text/plain", vec![]) };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let mime = match ext_of(&path).as_str() {
            "mp3" => "audio/mpeg",
            "flac" => "audio/flac",
            "m4a" | "aac" => "audio/mp4",
            "ogg" | "oga" | "opus" => "audio/ogg",
            "wav" => "audio/wav",
            "webm" => "audio/webm",
            _ => "application/octet-stream",
        };
        // Range: bytes=start-[end]
        let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).and_then(|v| {
            let (s, e) = v.strip_prefix("bytes=")?.split_once('-')?;
            Some((s.parse::<u64>().ok()?, e.parse::<u64>().ok()))
        });
        let (start, end, partial) = match range {
            Some((s, e)) if s < len => (s, e.unwrap_or(len - 1).min(len - 1).min(s + CHUNK - 1), true),
            Some(_) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(vec![])
                    .unwrap();
            }
            None => (0, len.saturating_sub(1), false),
        };
        let mut buf = vec![0u8; if len == 0 { 0 } else { (end - start + 1) as usize }];
        if f.seek(SeekFrom::Start(start)).and_then(|_| f.read_exact(&mut buf)).is_err() {
            return reply(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", vec![]);
        }
        let mut res = Response::builder()
            .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, buf.len())
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
        if partial {
            res = res.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
        }
        res.body(buf).unwrap()
    }

    pub fn cover(&self, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let pic = self.allowed(&path_of(req)).and_then(|p| {
            let f = lofty::read_from_path(p).ok()?;
            let tag = f.primary_tag().or_else(|| f.first_tag())?;
            let pic = tag.pictures().first()?;
            Some((pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into()), pic.data().to_vec()))
        });
        match pic {
            Some((mime, data)) => Response::builder()
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CACHE_CONTROL, "max-age=86400")
                .body(data)
                .unwrap(),
            None => reply(StatusCode::NOT_FOUND, "text/plain", vec![]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(path: &Path, secs: u32) {
        let (sr, n) = (8000u32, 8000 * secs);
        let mut b = Vec::new();
        b.extend(b"RIFF"); b.extend((36 + n * 2).to_le_bytes()); b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes()); b.extend(1u16.to_le_bytes()); b.extend(1u16.to_le_bytes());
        b.extend(sr.to_le_bytes()); b.extend((sr * 2).to_le_bytes()); b.extend(2u16.to_le_bytes()); b.extend(16u16.to_le_bytes());
        b.extend(b"data"); b.extend((n * 2).to_le_bytes()); b.extend(vec![0u8; (n * 2) as usize]);
        std::fs::write(path, b).unwrap();
    }
    fn get(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut r = Request::builder().uri(uri);
        if let Some(v) = range { r = r.header(header::RANGE, v) }
        r.body(vec![]).unwrap()
    }
    fn url(p: &Path) -> String {
        format!("http://media.localhost/{}", percent_encoding::utf8_percent_encode(&p.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC))
    }

    #[test]
    fn scan_and_stream() {
        let dir = std::env::temp_dir().join(format!("aurora_lib_test_{}", std::process::id()));
        let sub = dir.join("专辑");
        std::fs::create_dir_all(&sub).unwrap();
        wav(&sub.join("测试歌手 - 低音测试.wav"), 2);
        std::fs::write(sub.join("notes.txt"), "x").unwrap();
        let outside = std::env::temp_dir().join(format!("aurora_outside_{}.wav", std::process::id()));
        wav(&outside, 1);

        let lib = Library::default();
        let tracks = lib.scan(vec![dir.to_string_lossy().into_owned()]);
        assert_eq!(tracks.len(), 1, "只收音频文件");
        assert_eq!((tracks[0].title.as_str(), tracks[0].artist.as_str()), ("低音测试", "测试歌手"));
        assert!((tracks[0].dur - 2.0).abs() < 0.05, "时长 {}", tracks[0].dur);

        let file = PathBuf::from(&tracks[0].path);
        let len = std::fs::metadata(&file).unwrap().len();
        let r = lib.media(&get(&url(&file), Some("bytes=100-199")));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes 100-199/{len}").as_str());
        assert_eq!(r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(r.body().len(), 100);
        let open = lib.media(&get(&url(&file), Some("bytes=0-")));
        assert_eq!(open.body().len() as u64, len);
        assert_eq!(lib.media(&get(&url(&outside), None)).status(), StatusCode::FORBIDDEN, "已添加路径之外的文件不放行");
        assert_eq!(lib.cover(&get(&url(&file).replace("media.", "cover."), None)).status(), StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_file(&outside).ok();
    }
}
