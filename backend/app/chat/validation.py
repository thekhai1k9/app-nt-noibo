import unicodedata

BIDI_CONTROLS = frozenset(chr(c) for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)))
# Ký tự "trống" nhìn như khoảng trắng nhưng không phải Zs/Cf.
BLANK_LOOKALIKES = frozenset("\u3164\u115f\u1160\uffa0")


def _invisible(ch: str) -> bool:
    return unicodedata.category(ch) in ("Cc", "Cf", "Zs", "Zl", "Zp") or ch in BLANK_LOOKALIKES


def check_group_name(v: str) -> str:
    """Tên nhóm hiển thị là text thuần: cấm ký tự điều khiển (kể cả NUL, xuống dòng, tab, ESC) và ký tự bidi ở
    bất kỳ vị trí nào; tên chỉ gồm ký tự vô hình/khoảng trắng bị từ chối."""
    for ch in v:
        if unicodedata.category(ch) in ("Cc", "Zl", "Zp"):  # gồm cả dấu ngắt dòng/đoạn Unicode
            raise ValueError("name must not contain control characters")
        if ch in BIDI_CONTROLS:
            raise ValueError("name must not contain bidi controls")
    if all(_invisible(ch) for ch in v):
        raise ValueError("name must contain visible characters")
    return v
