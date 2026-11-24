import { DuckBrainApiError, NamespaceClient } from '@duckbrain/sdk';
const c = new NamespaceClient({ baseUrl: 'http://127.0.0.1:20001', namespace: 'tarball_df_01' });
const mem = await c.createMemory({ body: { key: '/tarball/one', domain: 'concept', content: 'installed from the real tarball', attributes: { source: 'dogfood-2026-11-23' } } });
console.log('CREATE_OK', JSON.stringify(mem).slice(0, 140));
const list = await c.listMemories({ query: { namespace: 'tarball_df_01', limit: 5 } });
console.log('LIST_OK', JSON.stringify(list).slice(0, 200));
const dec = await c.declare_table({ path: { table: 'mytab' }, body: { columns: [{ name: 'id', type: 'integer' }], primary: 'id', force: true } });
console.log('DECLARE_OK', dec.table ?? JSON.stringify(dec).slice(0, 100));
const tables = await c.list_tables();
console.log('LIST_TABLES_OK', JSON.stringify(tables.tables?.map(t => t.name) ?? tables).slice(0, 150));
try {
  await c.insert_lane_scores({ body: [{ id: 'x' }] });
  console.log('INSERT_LANE_NO_ERROR');
} catch (e) {
  if (e instanceof DuckBrainApiError) console.log('API_ERROR_OK', e.status, e.code, String(e.message).slice(0, 90));
  else console.log('OTHER_ERROR', e.constructor.name, String(e.message).slice(0, 90));
}
