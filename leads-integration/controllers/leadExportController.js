const XLSX = require('xlsx');
const { collectLeadRows, safeCell } = require('../utils/leadRows');
const { assignedScope } = require('../utils/leadScope');

const toCsv = (rows) => rows.map((row) => row.map((cell) => {
  const text = safeCell(cell);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}).join(',')).join('\r\n');

// @desc    Download the leads the user may see as Excel or CSV
// @route   GET /api/leads/export?format=xlsx|csv
// @access  Owner, or staff with "Leads › Export" (staff without "View all" get only their own leads)
const exportLeads = async (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  try {
    // the leads this user may see (all of them, or only theirs)
    const values = await collectLeadRows({ companyId: req.leadsCompanyId, company: req.company, scope: assignedScope(req) });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Cache-Control', 'no-store');
    if (format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="leads-${stamp}.csv"`);
      return res.send(`﻿${toCsv(values)}`);
    }
    const sheet = XLSX.utils.aoa_to_sheet(values.map((row) => row.map(safeCell)));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Leads');
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="leads-${stamp}.xlsx"`);
    return res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  } catch (error) {
    console.error('[LEADS] Export failed:', error.message);
    return res.status(500).json({ message: 'Could not export leads' });
  }
};

module.exports = { exportLeads };
