from census import convert


def feat(**over):
    p = {"SA22023_V1_00": 123, "SA22023_V1_00_NAME": "Milford", "VAR_1_24": 4000, "VAR_1_16": 3800}
    for i in range(6):
        p[f"VAR_1_{17 + i}"] = 1000 * (i + 1)
        p[f"VAR_1_{9 + i}"] = 900 * (i + 1)
    p.update(over)
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[174.7, -36.7], [174.8, -36.7], [174.8, -36.8], [174.7, -36.7]]]}, "properties": p}


def test_convert_compacts_properties():
    f = convert(feat())
    assert f["properties"] == {"c": "123", "n": "Milford", "t": 4000, "g": [1000, 2000, 3000, 4000, 5000, 6000],
                               "t18": 3800, "g18": [900, 1800, 2700, 3600, 4500, 5400]}
    assert f["geometry"]["type"] == "Polygon"


def test_convert_skips_suppressed_or_empty_areas():
    assert convert(feat(VAR_1_24=None)) is None       # 공개 제한된 값
    assert convert(feat(VAR_1_24=0)) is None          # 거주자 없음
    assert convert(feat(VAR_1_18="-999"))["properties"]["g"][1] == 0   # 일부 분류만 비공개(음수)면 0 으로
