const locations = [
  { propertyId: 'peak-studios', latitude: -33.937453871131, longitude: 18.463181536372,
    source: 'https://www.lekkeslaap.co.za/accommodation/peak-studios-cape-town/location' },
  { propertyId: 'arteria-parktown', latitude: -26.177534, longitude: 28.047479,
    source: 'https://maps.apple.com/place?place-id=I867FDE82546F03EA' },
  { propertyId: 'crescent-studios', latitude: -26.19408, longitude: 28.02993,
    source: 'https://maps.apple.com/place?place-id=I33015F09CEB5BC1' },
  { propertyId: 'braamfontein-central', latitude: -26.19408, longitude: 28.02993,
    source: 'https://maps.apple.com/place?place-id=I33015F09CEB5BC1',
    note: 'User confirmed this entry is the same building as Crescent Studios.' },
  { propertyId: 'horizon-heights', latitude: -26.184834, longitude: 28.002849,
    source: 'https://maps.apple.com/place?place-id=IC8C134BEFD603F2B' },
  { propertyId: 'kingsway-place', latitude: -26.183779, longitude: 28.006389,
    source: 'https://yandex.com/maps/org/kingsway_place_student_accommodation/150169772773/' },
  { propertyId: 'brooklyn-studios', latitude: -25.757478, longitude: 28.233517,
    source: 'https://maps.apple.com/place?place-id=IE3C82B08CAA60606' },
  { propertyId: 'festivals-edge', latitude: -25.748691, longitude: 28.233047,
    source: 'https://mapcarta.com/W834944823' },
  { propertyId: 'fountains-view', latitude: -25.7605432, longitude: 28.1925032,
    source: 'https://maps.apple.com/place?place-id=IBB50D9E5CE0C7505' },
  { propertyId: 'hatfield-studios', latitude: -25.7518792, longitude: 28.2343,
    source: 'https://maps.apple.com/place?place-id=I410EDCB509F8EED' },
  { propertyId: 'hluma-studios', latitude: -29.865644, longitude: 30.983857,
    source: 'https://postmatric.co.za/student-accommodation/othq/thrive-student-living-hluma-studios' },
  { propertyId: 'studios-at-burnett', latitude: -25.750195, longitude: 28.238005,
    source: 'https://mapcarta.com/W710420545' },
  { propertyId: 'varsity-studios', latitude: -25.7485888, longitude: 28.236376,
    source: 'https://maps.apple.com/place?place-id=ICA0590A78DA6B519' },
  { propertyId: 'the-richmond', latitude: -26.183868, longitude: 28.003155,
    source: 'https://yandex.com/maps/org/the_richmond_student_accomodation/63086457298/' },
  { propertyId: 'richmond-central', latitude: -26.183868, longitude: 28.003155,
    source: 'https://yandex.com/maps/org/the_richmond_student_accomodation/63086457298/',
    note: 'User requested the nearest available pin: using neighbouring The Richmond at 42 Richmond Avenue; confirm on site.' }
];

async function seedLocations(pool) {
  const { validateBoundary } = await import('../www/technician-visits.mjs');
  for (const location of locations) {
    const pin = validateBoundary({ ...location, radius: 100 });
    await pool.query(`INSERT INTO technician_locations(property_id,latitude,longitude,radius)
      SELECT id,$2,$3,$4 FROM app_properties WHERE id=$1 AND active=TRUE
      ON CONFLICT(property_id) DO NOTHING`,
    [location.propertyId, pin.latitude, pin.longitude, pin.radius]);
  }
}

module.exports = { locations, seedLocations };
