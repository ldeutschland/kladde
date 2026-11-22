use std::collections::HashMap;

const LARGE_LOSS: usize = 200;
const LOSS_SHARE: usize = 10;
const SHARE_FLOOR: usize = 300;
const LARGE_GAIN: usize = 2000;
const GAIN_SHARE: usize = 2;
const GAIN_FLOOR: usize = 400;
const WORTH_KEEPING: usize = 100;

fn words(text: &[u8]) -> impl Iterator<Item = &[u8]> {
    text.split(u8::is_ascii_whitespace)
        .filter(|word| !word.is_empty())
}

fn changed_parts<'a>(before: &'a [u8], after: &'a [u8]) -> (&'a [u8], &'a [u8]) {
    let same = |(a, b): &(&u8, &u8)| a == b;
    let start = before.iter().zip(after).take_while(same).count();
    let rest = before.len().min(after.len()) - start;
    let tails = before.iter().rev().zip(after.iter().rev()).take(rest);
    let end = tails.take_while(same).count();

    (
        &before[start..before.len() - end],
        &after[start..after.len() - end],
    )
}

fn lost_bytes(before: &str, after: &str) -> usize {
    let (old, new) = changed_parts(before.as_bytes(), after.as_bytes());
    let mut kept: HashMap<&[u8], usize> = HashMap::new();

    for word in words(new) {
        *kept.entry(word).or_default() += 1;
    }

    let mut lost = 0;

    for word in words(old) {
        match kept.get_mut(word) {
            Some(count) if *count > 0 => *count -= 1,
            _ => lost += word.len(),
        }
    }

    lost
}

pub(super) fn loses_much(before: &str, after: &str) -> bool {
    let share = before.len().max(SHARE_FLOOR) / LOSS_SHARE;

    lost_bytes(before, after) >= LARGE_LOSS.min(share)
}

pub(super) fn gains_much(before: &str, after: &str) -> bool {
    if before.trim().len() < WORTH_KEEPING {
        return false;
    }

    let share = (before.len() / GAIN_SHARE).clamp(GAIN_FLOOR, LARGE_GAIN);

    lost_bytes(after, before) >= share
}

pub(super) fn changes_much(before: &str, after: &str) -> bool {
    loses_much(before, after) || gains_much(before, after)
}
