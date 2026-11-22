// Which look this page uses. /voxel (or ?style=voxel) = the voxel trial; everything else = the classic game.
export const VOXEL = typeof location !== 'undefined'
  && (/^\/voxel\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('style') === 'voxel');
