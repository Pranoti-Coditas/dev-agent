// Loads ../.env. Import this before any module that reads process.env at load time
// (ES module imports are hoisted, so calling dotenv.config() in cli.js body is too late).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env') });
