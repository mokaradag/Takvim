'use client';
import { createContext, useContext, useMemo } from 'react';
import { EMPTY_PERSON_LOOKUP, createPersonLookup } from './avatarIdentity.js';

/**
 * Kişi dizini bağlamı.
 *
 * Paylaşılan Avatar bileşenleri uygulama durumunu içe aktarmaz (mimari sınır).
 * Bunun yerine kabuk katmanı kişi listesini bu bağlama sağlar; Avatar yalnızca
 * hafif bir kimlik → kişi arama sözlüğü görür. Bağlam sağlanmadığında (izole
 * testler, eski çağrı yerleri) davranış eskisi gibi baş harflere düşer.
 */
const PeopleDirectoryContext = createContext(EMPTY_PERSON_LOOKUP);

export function PeopleDirectoryProvider({ people, children }) {
  const lookup = useMemo(() => createPersonLookup(people || []), [people]);
  return <PeopleDirectoryContext.Provider value={lookup}>{children}</PeopleDirectoryContext.Provider>;
}

export function usePersonLookup() {
  return useContext(PeopleDirectoryContext) || EMPTY_PERSON_LOOKUP;
}
