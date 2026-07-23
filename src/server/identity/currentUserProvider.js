import 'server-only';
import { ServerPersistenceError } from '../errors.js';

export class DevelopmentIdentityProvider {
  async getCurrentSicil() {
    if (!/^(1|true|yes)$/i.test(process.env.MERGEN_ROTA_DEV_IDENTITY_ENABLED || '')) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Gerçek Sistem kimliği yapılandırılmamış. Geçici geliştirme kimliğini açıkça etkinleştirin.');
    }
    const sicil = Number.parseInt(process.env.MERGEN_ROTA_DEV_SICIL || '', 10);
    if (!Number.isInteger(sicil) || sicil <= 0) {
      throw new ServerPersistenceError('UNAUTHORIZED', 'Geçerli bir sunucu tarafı geliştirme Sicil değeri yapılandırılmamış.');
    }
    return sicil;
  }
}

let provider = new DevelopmentIdentityProvider();

export function setCurrentUserProvider(nextProvider) {
  provider = nextProvider;
}

export async function getTrustedCurrentSicil() {
  return provider.getCurrentSicil();
}
