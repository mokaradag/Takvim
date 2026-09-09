import 'server-only';

/**
 * Kurumsal kullanıcı dizini — TEK e-posta kaynağı.
 *
 * Zincir her zaman aynıdır: `Sicil` → `MR_V_PeopleDirectory.Username`
 * (HR02 `kullanici_adi`) → `DC01_userr.Name` → `DC01_userr.EmailAddress`.
 * Hatırlatma postaları ve Outlook takvim davetleri bu çözümleyiciyi paylaşır;
 * ikinci bir kullanıcı/e-posta kaynağı tanımlanmaz.
 *
 * Tablo MERGEN Rota veritabanının İÇİNDEDİR (bkz. MERGEN_ROTA_DB_DATABASE),
 * MERGEN'e ait değildir: yalnızca okunur, hiçbir zaman yazılmaz.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function identifier(name, fallback) {
  const value = String(process.env[name] ?? '').trim() || fallback;
  if (!IDENTIFIER_PATTERN.test(value)) {
    // Şema/tablo adı sorgu metnine gömüldüğü için serbest metne izin verilmez.
    throw new Error(`${name} must be a plain SQL Server identifier.`);
  }
  return value;
}

/** Kurumsal kullanıcı tablosu. Varsayılan `dbo.DC01_userr`. */
export function corporateUserTable() {
  return `${identifier('MERGEN_ROTA_USER_DIRECTORY_SCHEMA', 'dbo')}.${identifier('MERGEN_ROTA_USER_DIRECTORY_TABLE', 'DC01_userr')}`;
}

/**
 * TEK bir Sicil için görünen ad ve kurumsal e-posta adresi.
 *
 * `OUTER APPLY` bilinçlidir: kullanıcı kaydı ya da adresi olmayan kişi de satır
 * olarak döner; eksiklik sessizce kaybolmaz, çağırana açıklanabilir bir sorun
 * olarak iletilir.
 */
export function corporateUserEmailSql() {
  return `
    SELECT TOP (1) pd.Sicil, pd.DisplayName AS Name, pd.Username, directory.EmailAddress AS Email
    FROM dbo.MR_V_PeopleDirectory pd
    OUTER APPLY (
      SELECT TOP (1) LTRIM(RTRIM(source.EmailAddress)) AS EmailAddress
      FROM ${corporateUserTable()} source
      WHERE pd.Username IS NOT NULL
        AND LTRIM(RTRIM(source.Name)) = LTRIM(RTRIM(pd.Username))
        AND NULLIF(LTRIM(RTRIM(source.EmailAddress)), '') IS NOT NULL
      ORDER BY source.EmailAddress
    ) directory
    WHERE pd.Sicil = @sicil;`;
}
