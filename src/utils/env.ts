import fs from 'fs';
import path from 'path';

/** Update .env file with key-value pairs (upsert) */
export function updateEnvFile(updates: Record<string, string>): void {
  const envPath = path.resolve(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch { /* file may not exist */ }

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(envPath, content);
}
