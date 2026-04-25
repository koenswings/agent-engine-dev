import { createClientStore } from './data/Store.js';
import { PeerId } from '@automerge/automerge-repo';
const result = await createClientStore(['127.0.0.1'], 'dump-client2' as PeerId, '4GQmEZehPDfryGDxkFo9XixbvmAC' as any, 10);
const doc = result.handle.doc() as any;
Object.values(doc?.userDB || {}).forEach((u: any) => console.log('USER:', u.username, '|', String(u.passwordHash)));
result.repo.shutdown();
process.exit(0);
