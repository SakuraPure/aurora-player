//! 网易云音乐客户端（桌面版）：移植自 NeteaseCloudMusicApi 中本项目用到的 13 个接口。
//! 全部走 weapi 通道（AES-128-CBC 两次 + RSA 无填充）——匿名状态下默认的 eapi 播放地址会被风控（-460），weapi 正常。
//! 登录 cookie 由前端保存，每次调用时传入；这里只负责补齐网易云要求的设备 cookie、加密、发请求。

use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use num_bigint::BigUint;
use rand::Rng;
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

const DOMAIN: &str = "https://music.163.com";
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const IV: &[u8; 16] = b"0102030405060708";
const PRESET_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const BASE62: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MODULUS: &str = "e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
/// 这些 code 表示请求本身成功（扫码状态、部分业务码），与原库一致
const OK_CODES: [i64; 9] = [200, 201, 302, 400, 502, 800, 801, 802, 803];

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

fn aes_cbc_b64(text: &[u8], key: &[u8; 16]) -> String {
    B64.encode(Aes128CbcEnc::new(key.into(), IV.into()).encrypt_padded_vec_mut::<Pkcs7>(text))
}

fn rsa_hex(text: &[u8]) -> String {
    let n = BigUint::parse_bytes(MODULUS.as_bytes(), 16).expect("modulus");
    let c = BigUint::from_bytes_be(text).modpow(&BigUint::from(65537u32), &n);
    format!("{:0>256}", c.to_str_radix(16))
}

/// weapi 加密：返回表单字段 (params, encSecKey)
fn weapi(text: &str, secret: &[u8; 16]) -> (String, String) {
    let params = aes_cbc_b64(aes_cbc_b64(text.as_bytes(), PRESET_KEY).as_bytes(), secret);
    let mut rev = *secret;
    rev.reverse();
    (params, rsa_hex(&rev))
}

fn rand_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    rand::thread_rng().fill(&mut b[..]);
    hex::encode(b)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 解析 "a=1; b=2" 形式的 cookie，忽略 Max-Age / Path 等属性
fn parse_cookie(s: &str) -> Vec<(String, String)> {
    const ATTRS: [&str; 7] = ["max-age", "expires", "path", "domain", "httponly", "secure", "samesite"];
    s.split(';')
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            let k = k.trim();
            if k.is_empty() || ATTRS.contains(&k.to_ascii_lowercase().as_str()) {
                return None;
            }
            Some((k.to_string(), v.trim().to_string()))
        })
        .collect()
}

pub struct Ncm {
    http: reqwest::Client,
    device: Vec<(String, String)>, // 每次启动生成一次的设备 cookie
}

impl Ncm {
    pub fn new() -> Self {
        let nuid = rand_hex(32);
        let letters: String = (0..6).map(|_| (b'a' + rand::thread_rng().gen_range(0..26)) as char).collect();
        let device = [
            ("__remember_me", "true".to_string()),
            ("ntes_kaola_ad", "1".to_string()),
            ("_ntes_nnid", format!("{nuid},{}", now_ms())),
            ("_ntes_nuid", nuid),
            ("WNMCID", format!("{letters}.{}.01.0", now_ms())),
            ("WEVNSM", "1.0.0".to_string()),
            ("osver", "Microsoft-Windows-10-Professional-build-19045-64bit".to_string()),
            ("os", "pc".to_string()),
            ("channel", "netease".to_string()),
            ("appver", "3.1.17.204416".to_string()),
            ("NMTID", format!("00O{}", rand_hex(19))),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        Self { http: reqwest::Client::builder().gzip(true).build().expect("http client"), device, }
    }

    /// 发一个 weapi 请求；返回 (响应 JSON, Set-Cookie 中的 name=value 列表)
    async fn request(&self, uri: &str, mut data: Value, cookie: &str) -> Result<(Value, Vec<String>), String> {
        let user = parse_cookie(cookie);
        let mut jar = self.device.clone();
        for (k, v) in &user {
            jar.retain(|(dk, _)| dk != k);
            jar.push((k.clone(), v.clone()));
        }
        let csrf = user.iter().find(|(k, _)| k == "__csrf").map(|(_, v)| v.clone()).unwrap_or_default();
        data["csrf_token"] = json!(csrf);

        let mut secret = [0u8; 16];
        for b in secret.iter_mut() {
            *b = BASE62[rand::thread_rng().gen_range(0..BASE62.len())];
        }
        let (params, enc_sec_key) = weapi(&data.to_string(), &secret);
        let cookie_header = jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");

        let res = self
            .http
            .post(format!("{DOMAIN}/weapi/{}", uri.trim_start_matches("/api/")))
            .header("Referer", DOMAIN)
            .header("User-Agent", UA)
            .header("Cookie", cookie_header)
            .form(&[("params", params), ("encSecKey", enc_sec_key)])
            .send()
            .await
            .map_err(|e| format!("网络错误：{e}"))?;
        let set_cookie: Vec<String> = res
            .headers()
            .get_all("set-cookie")
            .iter()
            .filter_map(|v| v.to_str().ok()?.split(';').next().map(|s| s.trim().to_string()))
            .collect();
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| format!("网络错误：{e}"))?;
        let body: Value = serde_json::from_str(&text).map_err(|_| format!("网易云返回了无法解析的内容（HTTP {status}）"))?;
        let code = body["code"].as_i64().or_else(|| body["code"].as_str()?.parse().ok()).unwrap_or(status as i64);
        if !OK_CODES.contains(&code) {
            let msg = body["message"].as_str().or(body["msg"].as_str()).unwrap_or("网易云接口错误");
            return Err(format!("{msg}（{code}）"));
        }
        Ok((body, set_cookie))
    }

    async fn req(&self, uri: &str, data: Value, cookie: &str) -> Result<Value, String> {
        Ok(self.request(uri, data, cookie).await?.0)
    }

    /// 与 Web 版中间层同名的接口，参数 / 返回结构保持一致
    pub async fn call(&self, name: &str, p: &Value, cookie: &str) -> Result<Value, String> {
        let s = |k: &str| match &p[k] {
            Value::String(v) => v.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        };
        let n = |k: &str, d: i64| p[k].as_i64().or_else(|| p[k].as_str()?.parse().ok()).unwrap_or(d);
        let ids_c = |ids: &[String]| format!("[{}]", ids.iter().map(|id| format!("{{\"id\":{id}}}")).collect::<Vec<_>>().join(","));
        match name {
            "cloudsearch" => {
                self.req("/api/cloudsearch/pc", json!({ "s": s("keywords"), "type": n("type", 1), "limit": n("limit", 30), "offset": n("offset", 0), "total": true }), cookie).await
            }
            "song_detail" => {
                let ids: Vec<String> = s("ids").split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
                self.req("/api/v3/song/detail", json!({ "c": ids_c(&ids) }), cookie).await
            }
            "song_url_v1" => {
                self.req("/api/song/enhance/player/url/v1", json!({ "ids": format!("[{}]", s("id")), "level": s("level"), "encodeType": "flac" }), cookie).await
            }
            "lyric" => {
                self.req("/api/song/lyric", json!({ "id": s("id"), "tv": -1, "lv": -1, "rv": -1, "kv": -1, "_nmclfl": 1 }), cookie).await
            }
            "playlist_track_all" => {
                let detail = self.req("/api/v6/playlist/detail", json!({ "id": s("id"), "n": 100000, "s": 8 }), cookie).await?;
                let (limit, offset) = (n("limit", 1000).max(0) as usize, n("offset", 0).max(0) as usize);
                let ids: Vec<String> = detail["playlist"]["trackIds"]
                    .as_array()
                    .map(|a| a.iter().skip(offset).take(limit).filter_map(|t| t["id"].as_i64().map(|i| i.to_string())).collect())
                    .unwrap_or_default();
                self.req("/api/v3/song/detail", json!({ "c": ids_c(&ids) }), cookie).await
            }
            "recommend_songs" => self.req("/api/v3/discovery/recommend/songs", json!({}), cookie).await,
            "toplist" => self.req("/api/toplist", json!({}), cookie).await,
            "login_qr_key" => {
                let body = self.req("/api/login/qrcode/unikey", json!({ "type": 3 }), cookie).await?;
                Ok(json!({ "code": 200, "data": body }))
            }
            "login_qr_create" => {
                let url = format!("{DOMAIN}/login?codekey={}", s("key"));
                let svg = qrcode::QrCode::new(url.as_bytes())
                    .map_err(|e| e.to_string())?
                    .render::<qrcode::render::svg::Color>()
                    .min_dimensions(240, 240)
                    .build();
                Ok(json!({ "code": 200, "data": { "qrurl": url, "qrimg": format!("data:image/svg+xml;base64,{}", B64.encode(svg)) } }))
            }
            "login_qr_check" => {
                let (mut body, set_cookie) = self.request("/api/login/qrcode/client/login", json!({ "key": s("key"), "type": 3 }), cookie).await?;
                body["cookie"] = json!(set_cookie.join("; "));
                Ok(body)
            }
            "user_account" => self.req("/api/nuser/account/get", json!({}), cookie).await,
            "user_playlist" => {
                self.req("/api/user/playlist", json!({ "uid": s("uid"), "limit": n("limit", 30), "offset": n("offset", 0), "includeVideo": true }), cookie).await
            }
            "logout" => self.req("/api/logout", json!({}), cookie).await,
            _ => Err(format!("未知接口：{name}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值由原库（crypto-js + node-forge）生成
    #[test]
    fn rsa_matches_original() {
        assert_eq!(
            rsa_hex(b"abcdefghijklmnop"),
            "9df4b31c1c8a9336bae7b12d17bef2aaebff40f867b875935d4a5c4324593c87e63ee2489e2f463432ce71e5667a73ca3e26bad55eff852c86182cf4047933b257c6785254936cf2b7518a7067cf4d55aa1e48cd119db0c9dbd2d3adec41c94a711eae94578cea17a3d32e0005b4372b5d09d5700f23c5727a6a6fe89a03c869"
        );
    }

    #[test]
    fn aes_matches_original() {
        assert_eq!(weapi(r#"{"a":1}"#, b"abcdefghijklmnop").0, "Ho/4Pu1bYyrzwcnXPnTcXm1Gb04eSzwGSNb4NI3YqZY=");
    }

    #[test]
    fn cookie_parsing_skips_attributes() {
        let c = parse_cookie("MUSIC_U=abc; Max-Age=100; Path=/; __csrf=x1");
        assert_eq!(c, vec![("MUSIC_U".into(), "abc".into()), ("__csrf".into(), "x1".into())]);
    }

    // 联网测试：cargo test -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_endpoints() {
        let ncm = Ncm::new();
        let s = ncm.call("cloudsearch", &json!({ "keywords": "晴天", "limit": 2 }), "").await.unwrap();
        assert!(s["result"]["songs"].as_array().is_some_and(|a| !a.is_empty()));
        let id = s["result"]["songs"][0]["id"].as_i64().unwrap();
        let u = ncm.call("song_url_v1", &json!({ "id": id, "level": "standard" }), "").await.unwrap();
        assert!(u["data"][0]["url"].as_str().is_some_and(|x| x.starts_with("http")), "url: {u}");
        let l = ncm.call("lyric", &json!({ "id": id }), "").await.unwrap();
        assert!(l["lrc"]["lyric"].is_string());
        let t = ncm.call("playlist_track_all", &json!({ "id": 3778678, "limit": 3 }), "").await.unwrap();
        assert_eq!(t["songs"].as_array().map(|a| a.len()), Some(3));
        let top = ncm.call("toplist", &json!({}), "").await.unwrap();
        assert!(top["list"].as_array().is_some_and(|a| a.len() > 10));
        let k = ncm.call("login_qr_key", &json!({}), "").await.unwrap();
        let key = k["data"]["unikey"].as_str().unwrap().to_string();
        let q = ncm.call("login_qr_create", &json!({ "key": key }), "").await.unwrap();
        assert!(q["data"]["qrimg"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));
        let c = ncm.call("login_qr_check", &json!({ "key": key }), "").await.unwrap();
        assert_eq!(c["code"], 801);
        let a = ncm.call("user_account", &json!({}), "").await.unwrap();
        assert!(a["profile"].is_null());
    }
}
