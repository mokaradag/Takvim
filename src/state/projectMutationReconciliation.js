/**
 * Proje yazması sonrasında mevcut istemci kapsamının güvenli olup olmadığını
 * denetler. Sunucu projeyi yankılamadıysa veya erişim FULL değilse yetkili
 * anlık görüntü yeniden yüklenir ve yükleme hatası çağırana aynen taşınır.
 */
export async function reconcileProjectMutationAccess(committedProject, reloadData) {
  if (committedProject?.accessLevel === 'FULL') return { ok: true, reloaded: false };
  const result = await reloadData();
  return result?.ok
    ? { ...result, reloaded: true }
    : result;
}
