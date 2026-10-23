'use client';

import React from 'react';
import { NAV_ITEMS, type NavItem, isRouteActive } from '../lib/navigation.js';

export { NAV_ITEMS, type NavItem };

export interface NavigationProps {
  currentPath?: string;
  onNavigate?: (href: string) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ currentPath = '/tasks', onNavigate }) => {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (onNavigate) {
      e.preventDefault();
      onNavigate(href);
    }
  };

  return (
    <nav
      data-testid="dashboard-navigation"
      aria-label="Chính"
      style={{
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        padding: '0 24px',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          gap: '8px',
          overflowX: 'auto',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = isRouteActive(item.href, currentPath);
          return (
            <a
              key={item.key}
              href={item.href}
              data-testid={`nav-link-${item.key}`}
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              onClick={(e) => handleClick(e, item.href)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '14px 16px',
                fontSize: '14px',
                fontWeight: active ? 600 : 500,
                color: active ? '#2563eb' : '#64748b',
                textDecoration: 'none',
                borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
                transition: 'all 0.15s ease-in-out',
                whiteSpace: 'nowrap',
              }}
            >
              <span>{item.label}</span>
              {item.badge && (
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 6px',
                    borderRadius: '10px',
                    backgroundColor: active ? '#dbeafe' : '#f1f5f9',
                    color: active ? '#1d4ed8' : '#64748b',
                  }}
                >
                  {item.badge}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </nav>
  );
};
