const ExcelJS = require('exceljs');

async function assetWorkbook(data) {
  const book = new ExcelJS.Workbook();
  book.creator = 'PrimeOps';
  book.created = new Date();
  const summary = book.addWorksheet('Building summary');
  summary.addRow(['PrimeOps - Machine asset management']);
  summary.addRow(['Generated (UTC)', book.created.toISOString()]);
  summary.addRow(['Breakdowns count separate repair episodes; repeated broken checks are not new breakdowns.']);
  summary.addRow(['Historical checks without a serial-linked asset', data.unlinkedChecks]);
  summary.addRow(['Building', 'Registered machines (including retired)', 'Active machines', 'Breakdown episodes', 'Currently need repair']);
  for (const building of data.buildings) {
    summary.addRow([data.properties.find((property) => property.id === building.property_id)?.name || building.property_id,
      building.machines, building.active, building.breakdowns, building.needs_repair]);
  }
  let index = 0;
  for (const property of data.properties) {
    const name = `${++index} ${property.name.replace(/[\\/*?:[\]]/g, ' ').replace(/'/g, '')}`.slice(0, 31);
    const sheet = book.addWorksheet(name);
    sheet.addRow(['PrimeOps - Building machine report']);
    sheet.addRow(['Building', property.name]);
    sheet.addRow(['Generated (UTC)', book.created.toISOString()]);
    sheet.addRow([]);
    sheet.addRow(['Machine register']);
    sheet.addRow(['Machine number', 'Type', 'Serial number', 'Model', 'Active', 'Status', 'Breakdowns', 'Checks', 'Parts requested', 'Ordered', 'Replaced', 'Last checked (UTC)', 'Retired (UTC)']);
    for (const machine of data.machines.filter((machine) => machine.property_id === property.id)) {
      sheet.addRow([machine.machine_number, machine.appliance_type, machine.serial_number, machine.model_number,
        machine.active ? 'Yes' : 'Retired', machine.status, machine.breakdowns, machine.inspections,
        machine.requested, machine.ordered, machine.replaced, machine.last_checked || '', machine.retired_at || '']);
    }
    sheet.addRow([]);
    sheet.addRow(['Frequently requested / ordered / replaced parts (ranked by replaced, ordered, requested)']);
    sheet.addRow(['Part number', 'Description', 'Requested', 'Ordered', 'Replaced']);
    for (const part of data.buildings.find((building) => building.property_id === property.id)?.parts || []) {
      sheet.addRow([part.part_number || 'Pending', part.name, part.requested, part.ordered, part.replaced]);
    }
    sheet.addRow([]);
    sheet.addRow(['Part request reconciliation']);
    sheet.addRow(['Machine', 'Serial', 'Report', 'Part number', 'Part', 'Requested', 'Ordered', 'Replaced']);
    for (const request of data.requests.filter((request) => request.property_id === property.id)) {
      sheet.addRow([request.machine_number, request.serial_number, request.report_id, request.part_number || 'Pending',
        request.name, request.requested, request.ordered, request.replaced]);
    }
    sheet.addRow([]);
    sheet.addRow(['Inspection history']);
    sheet.addRow(['Checked (UTC)', 'Machine', 'Serial', 'Status', 'Report']);
    for (const report of data.reports.filter((report) => report.property_id === property.id)) {
      for (const entry of report.entries || []) {
        sheet.addRow([entry.checkAudit?.completed?.capturedAt || report.created_at, entry.machineNumber,
          entry.serialNumber || 'Not recorded (historical)', entry.status, report.id]);
      }
    }
    sheet.addRow([]);
    sheet.addRow(['Part order / replacement audit trail']);
    sheet.addRow(['Recorded (UTC)', 'Machine', 'Serial', 'Part', 'Action', 'Quantity', 'Recorded by', 'Report']);
    for (const event of data.events) {
      const machine = data.machines.find((machine) => machine.id === event.asset_id && machine.property_id === property.id);
      if (!machine) continue;
      const request = data.requests.find((request) => request.report_id === event.report_id && request.asset_id === event.asset_id && request.part_id === event.part_id);
      sheet.addRow([event.created_at, machine.machine_number, machine.serial_number, request?.name || event.part_id,
        event.action, event.quantity, event.created_by, event.report_id]);
    }
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  }
  for (const sheet of book.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: sheet === summary ? 5 : 6 }];
    sheet.columns.forEach((column, i) => { column.width = i === 1 ? 36 : 24; });
    sheet.eachRow((row, number) => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (number === 1 || row.cellCount === 1 || row.getCell(1).value === 'Machine number'
          || ['Part number', 'Machine', 'Checked (UTC)', 'Recorded (UTC)', 'Building'].includes(row.getCell(1).value)) {
        row.font = { bold: true, color: { argb: 'FF493568' } };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE7F6' } };
      }
    });
  }
  return book.xlsx.writeBuffer();
}

module.exports = { assetWorkbook };
