import { DuckBrainApiError, NamespaceClient } from '@duckbrain/sdk';
const c = new NamespaceClient({ baseUrl: 'http://127.0.0.1:20001', namespace: 'tarball_df_01' });
await c.run_table_transaction({ body: { actions: [
  { op: 'insert', table: 'mytab', row: { id: 1 } },
  { op: 'insert', table: 'mytab', row: { id: 2 } },
] } });
console.log('TXN_INSERT_OK mytab ids 1,2');
try {
  const rows = await c.list_notes({ query: { select: '*', order: 'id.asc', limit: 10 } });
  console.log('UNEXPECTED_READ', JSON.stringify(rows).slice(0, 80));
} catch (e) {
  console.log('READ_NOTES_ERR', e.constructor.name, String(e.message).slice(0, 80));
}
