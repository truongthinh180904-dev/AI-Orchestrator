export interface NavItem {
  key: string;
  label: string;
  href: string;
  description: string;
  badge?: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'tasks',
    label: 'Tác vụ (Tasks)',
    href: '/tasks',
    description: 'Danh sách và tiến độ các tác vụ worker',
  },
  {
    key: 'import',
    label: 'Nhập Yêu Cầu (Import)',
    href: '/import',
    description: 'Nạp task từ file Excel hoặc CSV',
  },
  {
    key: 'controls',
    label: 'Điều Khiển (Controls)',
    href: '/controls',
    description: 'Tạm dừng, Tiếp tục, Dừng khẩn cấp',
  },
  {
    key: 'releases',
    label: 'Phát Hành & PR (Releases)',
    href: '/releases',
    description: 'Theo dõi branch release và Pull Requests',
  },
];

export function isRouteActive(itemHref: string, currentPath: string): boolean {
  if (itemHref === '/tasks') {
    return currentPath === '/' || currentPath === '/tasks' || currentPath.startsWith('/tasks/');
  }
  return currentPath === itemHref || currentPath.startsWith(`${itemHref}/`);
}
