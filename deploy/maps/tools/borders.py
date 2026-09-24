"""Land borders between countries, as India depicts them — deploy/maps/tools/borders-india-pov.geojson.

Source: Natural Earth 1:10m admin-0 countries, India point of view (ne_10m_admin_0_countries_ind,
public domain, Natural Earth v5+). Its India includes all of Jammu & Kashmir and Ladakh (Gilgit-
Baltistan, the area west of the Line of Control, Aksai Chin) and all of Arunachal Pradesh.

Country outlines would also trace every coastline, so only the edges two countries share are kept.

  python3 -m venv v && v/bin/pip install shapely
  curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries_ind.geojson
  v/bin/python borders.py ne_10m_admin_0_countries_ind.geojson borders-india-pov.geojson
"""
import json
import sys

from shapely.geometry import box, mapping, shape
from shapely.ops import linemerge

REGION = box(40, -5, 120, 50)  # what the maps can show: the Middle East to South-East Asia


def main(src, dst):
    data = json.load(open(src))
    countries = []
    for f in data['features']:
        g = shape(f['geometry'])
        if g.intersects(REGION):
            countries.append((f['properties']['ADM0_A3_IN'], g.buffer(0)))
    out = []
    for i in range(len(countries)):
        for j in range(i + 1, len(countries)):
            (a_code, a), (b_code, b) = countries[i], countries[j]
            if not a.buffer(0.02).intersects(b):
                continue
            shared = a.boundary.intersection(b.buffer(0.01))
            if shared.is_empty:
                continue
            if shared.geom_type == 'MultiLineString':
                shared = linemerge(shared)
            if shared.length < 0.05:
                continue
            out.append({'type': 'Feature', 'properties': {'a': a_code, 'b': b_code},
                        'geometry': mapping(shared.simplify(0.002))})
    json.dump({'type': 'FeatureCollection', 'features': out}, open(dst, 'w'))
    print(f'{len(out)} borders')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
