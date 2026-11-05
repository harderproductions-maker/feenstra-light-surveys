export function assetSummary(assets, reports, events) {
  const machines = assets.map((asset) => ({
    ...asset, breakdowns: 0, inspections: 0, status: 'Not checked', requested: 0, ordered: 0, replaced: 0
  }));
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  const requests = [];
  const checks = reports.flatMap((report) => (report.entries || []).map((entry) => ({ report, entry })))
    .sort((a, b) => Date.parse(a.entry.checkAudit?.completed?.capturedAt || a.report.created_at)
      - Date.parse(b.entry.checkAudit?.completed?.capturedAt || b.report.created_at)
      || Date.parse(a.report.created_at) - Date.parse(b.report.created_at) || a.report.id.localeCompare(b.report.id));
  let unlinkedChecks = 0;
  for (const { report, entry } of checks) {
    const machine = byId.get(entry.assetId);
    if (!machine) { unlinkedChecks++; continue; }
    if (entry.status === 'needs_repair' && machine.status !== 'needs_repair') machine.breakdowns++;
    machine.status = entry.status;
    machine.inspections++;
    machine.last_checked = entry.checkAudit?.completed?.capturedAt || report.created_at;
    for (const part of entry.parts) {
      const actions = events.filter((event) => event.report_id === report.id && event.asset_id === machine.id && event.part_id === part.id);
      const ordered = actions.filter((event) => event.action === 'ordered').reduce((total, event) => total + event.quantity, 0);
      const replaced = actions.filter((event) => event.action === 'replaced').reduce((total, event) => total + event.quantity, 0);
      machine.requested += part.quantity;
      machine.ordered += ordered;
      machine.replaced += replaced;
      requests.push({
        report_id: report.id, asset_id: machine.id, property_id: machine.property_id,
        machine_number: machine.machine_number, serial_number: machine.serial_number,
        part_id: part.id, name: part.name, part_number: part.part_number,
        requested: part.quantity, ordered, replaced
      });
    }
  }
  const buildings = [...new Set(machines.map((machine) => machine.property_id))].map((propertyId) => {
    const rows = machines.filter((machine) => machine.property_id === propertyId);
    const parts = new Map();
    for (const request of requests.filter((request) => request.property_id === propertyId)) {
      const key = JSON.stringify([request.part_number, request.name, request.part_number ? null : request.part_id]);
      if (!parts.has(key)) parts.set(key, { name: request.name, part_number: request.part_number, requested: 0, ordered: 0, replaced: 0 });
      const part = parts.get(key);
      for (const field of ['requested', 'ordered', 'replaced']) part[field] += request[field];
    }
    return {
      property_id: propertyId, machines: rows.length, active: rows.filter((row) => row.active).length,
      breakdowns: rows.reduce((total, row) => total + row.breakdowns, 0),
      needs_repair: rows.filter((row) => row.active && row.status === 'needs_repair').length,
      parts: [...parts.values()].sort((a, b) => b.replaced - a.replaced || b.ordered - a.ordered || b.requested - a.requested)
    };
  }).sort((a, b) => b.breakdowns - a.breakdowns || a.property_id.localeCompare(b.property_id));
  return { machines, buildings, requests, unlinkedChecks };
}
