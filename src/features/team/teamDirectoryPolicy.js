import {
  matchesDirectorateFilter as sharedMatchesDirectorateFilter,
  organizationValue as sharedOrganizationValue
} from '../../domain/organization/organizationHierarchy.js';

// Eski sabit içe aktarma yolu korunur; çalışma zamanı semantiği ortak domain
// modülündeki işlevlere yönlendirilir.
export const UNASSIGNED_DIRECTORATE = '__unassigned__';
export const UNASSIGNED_DIRECTORATE_LABEL = 'Direktörlük tanımsız';

export function organizationValue(person, field) {
  return sharedOrganizationValue(person, field);
}

export function matchesDirectorateFilter(person, selection) {
  return sharedMatchesDirectorateFilter(person, selection);
}
