/* ============================================================
   Icons — inline SVG, lucide-style, hand-picked
   ============================================================ */

export const Icon = ({ d, size = 16, stroke = 1.75, className = '', style }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor"
    strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    className={className} style={style}
  >
    <g dangerouslySetInnerHTML={{ __html: d }} />
  </svg>
);

export const Icons = {
  Dashboard: (p) => <Icon {...p} d='<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' />,
  Table: (p) => <Icon {...p} d='<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14"/>' />,
  Calendar: (p) => <Icon {...p} d='<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>' />,
  Gantt: (p) => <Icon {...p} d='<path d="M5 7h8M9 12h10M3 17h11"/><circle cx="3" cy="7" r="1"/><circle cx="20" cy="12" r="1"/><circle cx="16" cy="17" r="1"/>' />,
  Kanban: (p) => <Icon {...p} d='<path d="M5 3h4v18H5zM10 3h4v11h-4zM15 3h4v15h-4z"/>' />,
  Chart: (p) => <Icon {...p} d='<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/>' />,
  Users: (p) => <Icon {...p} d='<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' />,
  Search: (p) => <Icon {...p} d='<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>' />,
  Plus: (p) => <Icon {...p} d='<path d="M12 5v14M5 12h14"/>' />,
  Sun: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>' />,
  Moon: (p) => <Icon {...p} d='<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>' />,
  LogOut: (p) => <Icon {...p} d='<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>' />,
  LogIn: (p) => <Icon {...p} d='<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>' />,
  Settings: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' />,
  Command: (p) => <Icon {...p} d='<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>' />,
  Check: (p) => <Icon {...p} d='<path d="M20 6 9 17l-5-5"/>' />,
  Close: (p) => <Icon {...p} d='<path d="M18 6 6 18M6 6l12 12"/>' />,
  ChevronLeft: (p) => <Icon {...p} d='<path d="m15 18-6-6 6-6"/>' />,
  ChevronRight: (p) => <Icon {...p} d='<path d="m9 18 6-6-6-6"/>' />,
  ChevronDown: (p) => <Icon {...p} d='<path d="m6 9 6 6 6-6"/>' />,
  ChevronUp: (p) => <Icon {...p} d='<path d="m18 15-6-6-6 6"/>' />,
  Clock: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' />,
  Alert: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>' />,
  Briefcase: (p) => <Icon {...p} d='<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>' />,
  Target: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>' />,
  Trash: (p) => <Icon {...p} d='<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' />,
  Edit: (p) => <Icon {...p} d='<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>' />,
  Flag: (p) => <Icon {...p} d='<path d="M4 22V4a1 1 0 0 1 1-1h12l-2 4 2 4H5"/>' />,
  Mail: (p) => <Icon {...p} d='<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/>' />,
  Bell: (p) => <Icon {...p} d='<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>' />,
  MailCheck: (p) => <Icon {...p} d='<path d="M22 12V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9"/><path d="m2 7 10 7 10-7"/><path d="m16 19 2 2 4-4"/>' />,
  Link: (p) => <Icon {...p} d='<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' />,
  Filter: (p) => <Icon {...p} d='<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>' />,
  TrendUp: (p) => <Icon {...p} d='<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>' />,
  Circle: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="9"/>' />,
  Sparkle: (p) => <Icon {...p} d='<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>' />,
  Layers: (p) => <Icon {...p} d='<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m21 12-9 5-9-5"/><path d="m21 17-9 5-9-5"/>' />,
  ArrowRight: (p) => <Icon {...p} d='<path d="M5 12h14M13 5l7 7-7 7"/>' />,
  ArrowLeft: (p) => <Icon {...p} d='<path d="M19 12H5M11 19l-7-7 7-7"/>' />,
  Menu: (p) => <Icon {...p} d='<path d="M3 6h18M3 12h18M3 18h18"/>' />,
  Compass: (p) => <Icon {...p} d='<circle cx="12" cy="12" r="9"/><polygon points="15.6 8.4 13.3 13.3 8.4 15.6 10.7 10.7 15.6 8.4"/>' />,
  Database: (p) => <Icon {...p} d='<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>' />,
  // İki karşılıklı yay 24×24 görünüm alanında (12,12) çevresinde geometrik
  // olarak dengelidir; tek taraftaki eski ok dönüş sırasında yörüngeleniyordu.
  Refresh: (p) => <Icon {...p} d='<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.4-2L20 8"/><path d="M17.9 16a7 7 0 0 1-11.4 2L4 16"/>' />,

  Info: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" />
    </svg>
  ),
  Grip: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="currentColor" className={p.className || ''} style={p.style}>
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>
  ),
  Gift: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  ),
  Columns: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>
    </svg>
  ),
  Diamond: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <path d="M12 2 22 12 12 22 2 12z"/>
    </svg>
  ),
  Sparkles: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>
    </svg>
  ),
  Wand: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <path d="M3 21l12-12"/><path d="M14 4v3M19 4v3M21 6h-3M16 6h-3"/><path d="m13 11 3 3"/>
    </svg>
  ),
  Keyboard: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 17h10"/>
    </svg>
  ),
  Help: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>
    </svg>
  ),
  Coin: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <circle cx="12" cy="12" r="9"/><path d="M15 9.5a3 3 0 0 0-2.5-1.5h-1a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4h-1A3 3 0 0 1 9 14.5"/><path d="M12 6v2M12 16v2"/>
    </svg>
  ),
  Hours: (p) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={p.size || 16} height={p.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={p.className || ''} style={p.style}>
      <circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/><path d="M8 2.5 6 4M16 2.5 18 4"/>
    </svg>
  ),
};