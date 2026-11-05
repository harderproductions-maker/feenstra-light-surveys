const crypto = require('node:crypto');

const schema = `
  ALTER TABLE appliance_parts ADD COLUMN IF NOT EXISTS machine_type TEXT;
  ALTER TABLE appliance_parts ADD COLUMN IF NOT EXISTS alternate_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE appliance_parts ADD COLUMN IF NOT EXISTS benchmark_prices JSONB;
  UPDATE appliance_parts SET machine_type = CASE
    WHEN name ILIKE '%washer%' THEN 'Washer'
    WHEN name ILIKE '%dryer%' THEN 'Dryer'
    ELSE NULL END WHERE machine_type IS NULL;
`;

function spreadsheetParts(sheets) {
  const sheet = sheets.find((item) => item.sheet === 'Parts');
  if (!sheet || sheet.data[2]?.[0] !== 'Machine Model') throw new Error('The parts benchmark spreadsheet has an unexpected layout.');
  return sheet.data.slice(3).filter((row) => row[0]).map((row) => {
    const [model, description, oem, alternate, ...rest] = row;
    const suppliers = ['Universe Corp', 'Lead Laundry', 'Ludi Appliances', 'LvB'];
    const prices = suppliers.flatMap((supplier, index) => {
      const price = rest[index];
      if (price === null || price === undefined) return [];
      if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) throw new Error(`Invalid benchmark price for ${description}.`);
      return [{ supplier, price }];
    });
    const machineType = /Combo/i.test(model) ? 'Combo' : /Washer/i.test(model) ? 'Washer' : /Dryer/i.test(model) ? 'Dryer' : null;
    if (!machineType || !description || (!oem && !alternate)) throw new Error('A benchmark part has missing machine or part details.');
    return {
      id: `benchmark-${crypto.createHash('sha256').update(`${model}|${description}|${oem || ''}|${alternate || ''}`).digest('hex').slice(0, 24)}`,
      name: `${model} - ${description}`, machine_type: machineType,
      part_number: String(oem || alternate), alternate_number: String(alternate || ''), benchmark_prices: prices
    };
  });
}

async function seedBenchmark(pool) {
  const parts = spreadsheetParts([{ sheet: 'Parts', data: [[], [], ['Machine Model'], ...require('./parts-benchmark.json')] }]);
  for (const part of parts) {
    // These two OEM numbers already exist in the original supplied catalogue.
    const id = ['200923', '204696'].includes(part.part_number) ? `speedqueen-${part.part_number}` : part.id;
    await pool.query(`INSERT INTO appliance_parts(id,name,part_number,supplier,machine_type,alternate_number,benchmark_prices)
      VALUES($1,$2,$3,'',$4,$5,$6::jsonb) ON CONFLICT(id) DO UPDATE
      SET machine_type=EXCLUDED.machine_type, alternate_number=EXCLUDED.alternate_number, benchmark_prices=EXCLUDED.benchmark_prices
      WHERE appliance_parts.benchmark_prices IS NULL`,
    [id, part.name, part.part_number, part.machine_type, part.alternate_number, JSON.stringify(part.benchmark_prices)]);
  }
}

function publicPart(part, canSeePrices) {
  const { benchmark_prices, ...details } = part;
  return canSeePrices ? { ...details, benchmark_prices } : details;
}

module.exports = { schema, spreadsheetParts, seedBenchmark, publicPart };
