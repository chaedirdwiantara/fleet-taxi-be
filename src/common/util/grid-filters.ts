/**
 * Query params every monitoring pivot (Gojek + Grab, admin + partner portal)
 * accepts to narrow its TABLE. Kept here rather than restated per controller so
 * the four surfaces document — and therefore behave — identically, and so the
 * exported OpenAPI the frontend generates from says the same thing everywhere.
 *
 * Both filters are applied server-side, before the per-day and table totals are
 * accumulated: the TOTAL row and the Summary block always describe exactly the
 * rows on screen. Dashboard cards and charts come from the summary endpoints and
 * stay whole-fleet on purpose.
 */

export const GRID_SEARCH_PARAM = 'q';
export const GRID_SEARCH_DOC =
  'Free-text search over the row identity: matches a normalized plate substring ' +
  'OR a driver-name substring. In mode=driver a plate match reads as "drove that plate".';

export const GRID_VEHICLE_TYPE_PARAM = 'vehicleType';
export const GRID_VEHICLE_TYPE_DOC =
  'Vehicle Type ("Tipe Kendaraan"), repeatable. A row is kept when ANY of its ' +
  'plates is of a listed type. Compared case-insensitively against the same ' +
  'resolved Type the grid displays; the selectable values are availableVehicleTypes.';
