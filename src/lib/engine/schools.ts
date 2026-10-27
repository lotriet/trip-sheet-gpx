/**
 * Wake County schools the runs in this area serve, with their map location
 * (public OpenStreetMap data, looked up once). Used when the geocoder is slow
 * or answers with a school on the other side of the county, so a stop like
 * "GREEN HOPE HS" always lands on the right campus and the right map area.
 */
export const KNOWN_SCHOOLS: [name: string, lat: number, lon: number][] = [
  ["Apex High School", 35.7457, -78.83835],
  ["Athens Drive High School", 35.76805, -78.71077],
  ["Broughton High School", 35.79067, -78.65261],
  ["Cary High School", 35.77128, -78.76626],
  ["Corinth Holders High School", 35.72431, -78.33846],
  ["Enloe High School", 35.78351, -78.60285],
  ["Fuquay-Varina High School", 35.59805, -78.79509],
  ["Garner Magnet High School", 35.71032, -78.63727],
  ["Green Hope High School", 35.80551, -78.86684],
  ["Green Level High School", 35.77313, -78.89865],
  ["Heritage High School", 35.94064, -78.51078],
  ["Knightdale High School of Collaborative Design", 35.81047, -78.47756],
  ["Leesville Road High School", 35.89083, -78.71861],
  ["Middle Creek High School", 35.66636, -78.76042],
  ["Millbrook High School", 35.86645, -78.60323],
  ["Panther Creek High School", 35.83001, -78.88828],
  ["Rolesville High School", 35.90609, -78.44142],
  ["Sanderson High School", 35.86129, -78.64665],
  ["South Garner High School", 35.65482, -78.57966],
  ["Southeast Raleigh High School", 35.74601, -78.60386],
  ["Wake Forest High School", 35.98534, -78.51597],
  ["Wakefield High School", 35.94707, -78.57185],
  ["Willow Spring High School", 35.57488, -78.73724],
  ["Wake STEM Early College High School", 35.75503, -78.74015],
  ["Crossroads Flex High School", 35.75475, -78.73837],
  ["Mary E. Phillips High School", 35.78827, -78.6162],
  ["Longview School", 35.78547, -78.61007],
  ["Morrisville Elementary School", 35.81134, -78.84632],
  ["Davis Drive Middle School", 35.77719, -78.85107],
  ["Davis Drive Elementary School", 35.77967, -78.85119],
  ["Highcroft Drive Elementary", 35.80058, -78.88402],
  ["Mills Park Middle", 35.81283, -78.89615],
  ["Mills Park Elementary", 35.81058, -78.89662],
  ["Alston Ridge Middle School", 35.85499, -78.90508],
  ["Alston Ridge Elementary School", 35.85925, -78.89968],
  ["Carpenter Elementary School", 35.81492, -78.86689],
  ["Cedar Fork Elementary School", 35.83705, -78.83955],
  ["Turner Creek Elementary", 35.77235, -78.87509],
  ["Parkside Elementary School", 35.84315, -78.86176],
  ["West Cary Middle School", 35.80265, -78.79445],
  ["Pine Hollow Middle School", 35.90753, -78.73433],
  ["Northwoods Elementary School", 35.79542, -78.79016],
  ["Martin Middle School", 35.81221, -78.68552],
  // OpenStreetMap spells it "White Oak Elementry".
  ["White Oak Elementary School", 35.7804, -78.9214],
];

/** Wake County, for keeping geocoder answers in the county. */
export const WAKE_BBOX = { minLon: -79.05, minLat: 35.5, maxLon: -78.25, maxLat: 36.1 };
