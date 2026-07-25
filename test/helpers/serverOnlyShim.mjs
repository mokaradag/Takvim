/**
 * `server-only` paketi düz Node çalışma zamanında hata fırlatır (yalnızca React
 * Server Component koşulunda boş modüle çözülür). Sunucu modüllerini testten
 * içe aktarabilmek için paketi boş bir modüle yönlendiren çözümleme kancası.
 * Başka hiçbir modül taklit edilmez; test edilen kod gerçek koddur.
 */
import { registerHooks } from 'node:module';

let registered = false;

export function registerServerOnlyShim() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'server-only') {
        return { url: 'data:text/javascript,export default {};', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  });
}
