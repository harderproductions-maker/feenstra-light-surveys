ALTER TABLE app_units
  ADD COLUMN floor TEXT NOT NULL DEFAULT '' CHECK(length(floor)<=80),
  ADD COLUMN unit_type TEXT NOT NULL DEFAULT '' CHECK(length(unit_type)<=100),
  ADD COLUMN bedrooms INTEGER CHECK(bedrooms BETWEEN 0 AND 100),
  ADD COLUMN bathrooms INTEGER CHECK(bathrooms BETWEEN 0 AND 100),
  ADD COLUMN parking_bays INTEGER CHECK(parking_bays BETWEEN 0 AND 100),
  ADD COLUMN floor_area NUMERIC(12,2) CHECK(floor_area BETWEEN 0 AND 1000000),
  ADD COLUMN audit_status TEXT NOT NULL DEFAULT '' CHECK(audit_status IN ('','vacant','occupied','reserved','maintenance','notice_given'));
