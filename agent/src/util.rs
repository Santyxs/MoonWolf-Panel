//! Utilidades varias.

use std::cmp::Ordering;
use std::time::Duration;

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Compara versiones tipo "1.2" / "1.10".
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let pa = parse(a);
    let pb = parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let na = pa.get(i).copied().unwrap_or(0);
        let nb = pb.get(i).copied().unwrap_or(0);
        match na.cmp(&nb) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_order() {
        assert_eq!(compare_versions("1.10", "1.2"), Ordering::Greater);
        assert_eq!(compare_versions("2.0", "1.99"), Ordering::Greater);
    }
}
