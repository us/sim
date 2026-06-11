'use client'

import { createContext, useContext } from 'react'

/**
 * Marks a React subtree as living inside an open `ModalContent` (the
 * platform's only Radix modal Dialog surface). Floating primitives that must
 * coordinate with the dialog's scroll lock and focus trap read this to adapt —
 * e.g. `DropdownMenu` upgrades itself to a modal menu inside dialogs, because
 * a non-modal menu portals outside the dialog's `react-remove-scroll` subtree
 * and its content cannot be wheel-scrolled.
 */
const InsideModalContext = createContext(false)

export const InsideModalProvider = InsideModalContext.Provider

/** Whether the calling component is rendered inside a `ModalContent`. */
export function useInsideModal(): boolean {
  return useContext(InsideModalContext)
}
