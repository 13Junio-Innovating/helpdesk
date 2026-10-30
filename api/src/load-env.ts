import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Importado ANTES do AppModule (imports ESM são avaliados em ordem): o ConfigModule valida o env ao carregar.
// Usa o .env do diretório atual ou da raiz do monorepo; variáveis já definidas no ambiente têm prioridade.
for (const file of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
    break;
  }
}
