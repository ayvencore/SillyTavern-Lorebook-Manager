import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import {
    createNewWorldInfo,
    deleteWorldInfo,
    getFreeWorldName,
    importWorldInfo,
    loadWorldInfo,
    openWorldInfoEditor,
    saveWorldInfo,
    selected_world_info,
} from '../../../world-info.js';

import { Popup } from '../../../popup.js';
import {
    ensureImageFormatSupported,
    getBase64Async,
    saveBase64AsFile,
} from '../../../utils.js';

const MODULE_SETTINGS_KEY = 'lorebookManager';
const LOREBOOK_META_KEY = 'lorebook_manager';
const IMAGE_SUBFOLDER = 'lorebook-manager';
const SPECIAL_FOLDERS = Object.freeze({
    ALL: '__all__',
    UNFILED: '__unfiled__',
});
const PAGE_SIZE_OPTIONS = Object.freeze([10, 25, 50, 100]);

const DEFAULT_SETTINGS = Object.freeze({
    folders: [],
    activeFolderId: SPECIAL_FOLDERS.ALL,
    sort: 'name-asc',
    pageSize: 25,
});

const state = {
    initialized: false,
    isOpen: false,
    isLoading: false,
    lorebooks: [],
    entryCounts: {},
    activeFolderId: SPECIAL_FOLDERS.ALL,
    search: '',
    sort: DEFAULT_SETTINGS.sort,
    pageSize: DEFAULT_SETTINGS.pageSize,
    currentPage: 1,
    pendingCoverTarget: '',
    refreshToken: 0,
    refreshTimer: null,
    dom: {},
    buttonObserver: null,
    worldListObserver: null,
};

const EXTENSION_NAME = (() => {
    const pathname = new URL(import.meta.url).pathname;
    const match = pathname.match(/\/scripts\/extensions\/(.+)\/[^/]+$/);
    return match?.[1] ? decodeURIComponent(match[1]) : 'third-party/SillyTavern-Lorebook-Manager';
})();

function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function getManagerSettings() {
    if (!isObject(extension_settings[MODULE_SETTINGS_KEY])) {
        extension_settings[MODULE_SETTINGS_KEY] = structuredClone(DEFAULT_SETTINGS);
    }

    const settings = extension_settings[MODULE_SETTINGS_KEY];
    if (!Array.isArray(settings.folders)) {
        settings.folders = [];
    }
    if (typeof settings.activeFolderId !== 'string') {
        settings.activeFolderId = DEFAULT_SETTINGS.activeFolderId;
    }
    if (typeof settings.sort !== 'string') {
        settings.sort = DEFAULT_SETTINGS.sort;
    }
    settings.pageSize = normalizePageSize(settings.pageSize);

    return settings;
}

function normalizePageSize(value) {
    const numericValue = Number(value);
    return PAGE_SIZE_OPTIONS.includes(numericValue) ? numericValue : DEFAULT_SETTINGS.pageSize;
}

function saveManagerSettings() {
    getContext().saveSettingsDebounced();
}

function getFolders() {
    return getManagerSettings().folders;
}

function setActiveFolder(folderId) {
    const settings = getManagerSettings();
    settings.activeFolderId = folderId;
    state.activeFolderId = folderId;
    state.currentPage = 1;
    saveManagerSettings();
    renderManager();
}

function clampCurrentPage(totalItems = getVisibleLorebooks().length) {
    const totalPages = Math.max(1, Math.ceil(totalItems / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
    return totalPages;
}

function setCurrentPage(pageNumber) {
    state.currentPage = Math.max(1, Number(pageNumber) || 1);
    clampCurrentPage();
    state.dom.grid?.scrollTo?.({ top: 0, behavior: 'auto' });
    renderManager();
}

function getFolderById(folderId) {
    return getFolders().find(folder => folder.id === folderId) || null;
}

function getSortedFolders(parentId = null) {
    return getFolders()
        .filter(folder => (folder.parentId || null) === parentId)
        .slice()
        .sort((a, b) => {
            const aRank = Number(a.sortOrder ?? 0);
            const bRank = Number(b.sortOrder ?? 0);
            return aRank - bRank || String(a.name).localeCompare(String(b.name));
        });
}

function getFolderChain(folderId) {
    const chain = [];
    const visited = new Set();
    let currentId = folderId || null;

    while (currentId) {
        if (visited.has(currentId)) {
            break;
        }
        visited.add(currentId);

        const folder = getFolderById(currentId);
        if (!folder) {
            break;
        }

        chain.unshift(folder);
        currentId = folder.parentId || null;
    }

    return chain;
}

function getFolderPathLabel(folderId) {
    if (!folderId) {
        return 'No Folder';
    }

    const chain = getFolderChain(folderId);
    return chain.length ? chain.map(folder => folder.name).join(' / ') : 'No Folder';
}

function getFolderSubtreeIds(folderId) {
    const ids = new Set();
    if (!folderId) {
        return ids;
    }

    const queue = [folderId];
    while (queue.length) {
        const currentId = queue.shift();
        if (!currentId || ids.has(currentId)) {
            continue;
        }

        ids.add(currentId);
        const children = getFolders().filter(folder => folder.parentId === currentId);
        children.forEach(child => queue.push(child.id));
    }

    return ids;
}

function countLorebooksForFolder(folderId) {
    const subtree = getFolderSubtreeIds(folderId);
    return state.lorebooks.filter(record => subtree.has(record.folderId)).length;
}

function countUnfiledLorebooks() {
    return state.lorebooks.filter(record => !record.folderId).length;
}

function isRealFolderId(folderId) {
    return Boolean(folderId) && folderId !== SPECIAL_FOLDERS.ALL && folderId !== SPECIAL_FOLDERS.UNFILED;
}

function normalizeLorebookMeta(rawMeta) {
    if (!isObject(rawMeta)) {
        return {};
    }

    const meta = {};

    if (typeof rawMeta.bookId === 'string' && rawMeta.bookId.trim()) {
        meta.bookId = rawMeta.bookId.trim();
    }

    if (typeof rawMeta.folderId === 'string' && rawMeta.folderId.trim()) {
        meta.folderId = rawMeta.folderId.trim();
    }

    if (typeof rawMeta.coverPath === 'string' && rawMeta.coverPath.trim()) {
        meta.coverPath = rawMeta.coverPath.trim().replace(/\\/g, '/');
    }

    return meta;
}

function cleanLorebookMeta(meta) {
    const normalized = normalizeLorebookMeta(meta);
    return Object.keys(normalized).length ? normalized : null;
}

function normalizeLorebookRecord(item) {
    const managerMeta = normalizeLorebookMeta(item?.extensions?.[LOREBOOK_META_KEY]);
    const apiName = String(item?.file_id || item?.name || '').trim();
    const displayName = String(item?.name || apiName).trim() || apiName;

    return {
        apiName,
        displayName,
        bookId: managerMeta.bookId || '',
        folderId: managerMeta.folderId || null,
        coverPath: managerMeta.coverPath || '',
        entryCount: Object.hasOwn(state.entryCounts, apiName) ? state.entryCounts[apiName] : null,
    };
}

function getLorebookMetaFromData(data) {
    if (!isObject(data) || !isObject(data.extensions)) {
        return {};
    }

    return normalizeLorebookMeta(data.extensions[LOREBOOK_META_KEY]);
}

function toClientImagePath(path) {
    if (!path) {
        return '';
    }

    return `/${String(path).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`;
}

function findLorebook(apiName) {
    return state.lorebooks.find(record => record.apiName === apiName) || null;
}

function applyLorebookMetaToState(apiName, meta) {
    const normalized = cleanLorebookMeta(meta) || {};

    state.lorebooks = state.lorebooks.map(record => {
        if (record.apiName !== apiName) {
            return record;
        }

        return {
            ...record,
            bookId: normalized.bookId || '',
            folderId: normalized.folderId || null,
            coverPath: normalized.coverPath || '',
        };
    });

    updateWorldToolbarButtons();
}

function getSortableEntryCount(record, direction) {
    if (typeof record.entryCount === 'number') {
        return record.entryCount;
    }

    return direction === 'asc' ? Number.MAX_SAFE_INTEGER : -1;
}

function compareLorebooks(a, b) {
    switch (state.sort) {
        case 'name-desc':
            return String(b.displayName).localeCompare(String(a.displayName)) || String(b.apiName).localeCompare(String(a.apiName));
        case 'entries-desc':
            return getSortableEntryCount(b, 'desc') - getSortableEntryCount(a, 'desc') || String(a.displayName).localeCompare(String(b.displayName));
        case 'entries-asc':
            return getSortableEntryCount(a, 'asc') - getSortableEntryCount(b, 'asc') || String(a.displayName).localeCompare(String(b.displayName));
        case 'name-asc':
        default:
            return String(a.displayName).localeCompare(String(b.displayName)) || String(a.apiName).localeCompare(String(b.apiName));
    }
}

function getVisibleLorebooks() {
    const searchTerm = state.search.trim().toLowerCase();
    const folderFilter = state.activeFolderId;
    const subtree = isRealFolderId(folderFilter) ? getFolderSubtreeIds(folderFilter) : null;

    return state.lorebooks
        .filter(record => {
            if (folderFilter === SPECIAL_FOLDERS.UNFILED && record.folderId) {
                return false;
            }

            if (subtree && !subtree.has(record.folderId)) {
                return false;
            }

            if (!searchTerm) {
                return true;
            }

            const haystack = [
                record.displayName,
                record.apiName,
                getFolderPathLabel(record.folderId),
            ].join(' ').toLowerCase();

            return haystack.includes(searchTerm);
        })
        .sort(compareLorebooks);
}

function setLoading(isLoading) {
    state.isLoading = isLoading;

    if (!state.dom.loading) {
        return;
    }

    state.dom.loading.classList.toggle('lmb_hidden', !isLoading);
}

function setEmptyMessage(message = '') {
    if (!state.dom.empty) {
        return;
    }

    state.dom.empty.textContent = message;
    state.dom.empty.classList.toggle('lmb_hidden', !message);
}

async function ensureManagerDom() {
    if (state.dom.modal) {
        return;
    }

    const host = document.createElement('div');
    host.innerHTML = await renderExtensionTemplateAsync(EXTENSION_NAME, 'manager');

    const modal = host.firstElementChild;
    if (!modal) {
        throw new Error('Failed to render Lorebook Manager template');
    }

    document.body.appendChild(modal);

    state.dom = {
        modal,
        refresh: modal.querySelector('#lmb_refresh'),
        search: modal.querySelector('#lmb_search'),
        sort: modal.querySelector('#lmb_sort'),
        pageSize: modal.querySelector('#lmb_page_size'),
        newLorebook: modal.querySelector('#lmb_new_lorebook'),
        importLorebook: modal.querySelector('#lmb_import_lorebook'),
        newFolder: modal.querySelector('#lmb_new_folder'),
        newSubfolder: modal.querySelector('#lmb_new_subfolder'),
        folderTree: modal.querySelector('#lmb_folder_tree'),
        breadcrumb: modal.querySelector('#lmb_breadcrumb'),
        summary: modal.querySelector('#lmb_summary'),
        pageControls: modal.querySelector('#lmb_page_controls'),
        pageLabel: modal.querySelector('#lmb_page_label'),
        prevPage: modal.querySelector('#lmb_prev_page'),
        nextPage: modal.querySelector('#lmb_next_page'),
        loading: modal.querySelector('#lmb_loading'),
        empty: modal.querySelector('#lmb_empty'),
        grid: modal.querySelector('#lmb_grid'),
        coverInput: modal.querySelector('#lmb_cover_input'),
        importInput: modal.querySelector('#lmb_import_input'),
    };

    bindManagerEvents();
}

function bindManagerEvents() {
    state.dom.modal.addEventListener('click', onModalClick);
    state.dom.search.addEventListener('input', () => {
        state.search = state.dom.search.value;
        state.currentPage = 1;
        renderManager();
    });
    state.dom.sort.addEventListener('change', () => {
        state.sort = state.dom.sort.value;
        state.currentPage = 1;
        getManagerSettings().sort = state.sort;
        saveManagerSettings();
        renderManager();
    });
    state.dom.pageSize.addEventListener('change', () => {
        state.pageSize = normalizePageSize(state.dom.pageSize.value);
        state.currentPage = 1;
        getManagerSettings().pageSize = state.pageSize;
        saveManagerSettings();
        renderManager();
    });
    state.dom.refresh.addEventListener('click', () => refreshLorebooks({ showLoader: true }));
    state.dom.newLorebook.addEventListener('click', onCreateLorebookClick);
    state.dom.importLorebook.addEventListener('click', () => state.dom.importInput.click());
    state.dom.newFolder.addEventListener('click', () => openCreateFolderPrompt(null));
    state.dom.newSubfolder.addEventListener('click', () => openCreateFolderPrompt(getSelectedRealFolderId()));
    state.dom.prevPage.addEventListener('click', () => setCurrentPage(state.currentPage - 1));
    state.dom.nextPage.addEventListener('click', () => setCurrentPage(state.currentPage + 1));
    state.dom.importInput.addEventListener('change', onImportInputChange);
    state.dom.coverInput.addEventListener('change', onCoverInputChange);
    state.dom.folderTree.addEventListener('click', onFolderTreeClick);
    state.dom.folderTree.addEventListener('dragover', onFolderTreeDragOver);
    state.dom.folderTree.addEventListener('dragleave', onFolderTreeDragLeave);
    state.dom.folderTree.addEventListener('drop', onFolderTreeDrop);
    state.dom.grid.addEventListener('click', onLorebookGridClick);
    state.dom.grid.addEventListener('change', onLorebookGridChange);
    state.dom.grid.addEventListener('dragstart', onLorebookDragStart);
    state.dom.grid.addEventListener('dragend', onLorebookDragEnd);
    state.dom.grid.addEventListener('error', onCoverImageError, true);

    document.addEventListener('keydown', (event) => {
        if (!state.isOpen || event.key !== 'Escape') {
            return;
        }

        closeManager();
    });
}

function onModalClick(event) {
    const actionElement = event.target.closest('[data-lmb-action]');
    if (!actionElement) {
        return;
    }

    if (actionElement.dataset.lmbAction === 'close') {
        closeManager();
    }
}

async function openManager() {
    await ensureManagerDom();
    collapseWorldInfoDrawer();

    state.isOpen = true;
    state.dom.modal.classList.remove('lmb_hidden');
    state.dom.search.value = state.search;
    state.dom.sort.value = state.sort;
    state.dom.pageSize.value = String(state.pageSize);

    await refreshLorebooks({ showLoader: true });
}

function closeManager() {
    if (!state.dom.modal) {
        return;
    }

    state.isOpen = false;
    state.dom.modal.classList.add('lmb_hidden');
    clearDropTargetStyles();
}

function getSelectedRealFolderId() {
    return isRealFolderId(state.activeFolderId) ? state.activeFolderId : null;
}

async function fetchLorebookList() {
    const response = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(`Failed to load lorebooks (${response.status})`);
    }

    const payload = await response.json();
    return Array.isArray(payload) ? payload.map(normalizeLorebookRecord) : [];
}

async function refreshLorebooks({ showLoader = false } = {}) {
    const refreshToken = ++state.refreshToken;

    if (showLoader) {
        setLoading(true);
    }

    try {
        const lorebooks = await fetchLorebookList();

        if (refreshToken !== state.refreshToken) {
            return;
        }

        state.lorebooks = lorebooks;

        const settings = getManagerSettings();
        const folderExists = isRealFolderId(settings.activeFolderId) ? Boolean(getFolderById(settings.activeFolderId)) : true;
        if (!folderExists) {
            settings.activeFolderId = SPECIAL_FOLDERS.ALL;
            saveManagerSettings();
        }

        state.activeFolderId = folderExists ? settings.activeFolderId : SPECIAL_FOLDERS.ALL;
        state.sort = settings.sort || DEFAULT_SETTINGS.sort;
        state.pageSize = normalizePageSize(settings.pageSize);

        updateWorldToolbarButtons();
        renderManager();
        hydrateEntryCounts(lorebooks, refreshToken);
    } catch (error) {
        console.error('[Lorebook Manager] Failed to refresh lorebooks', error);
        setEmptyMessage('Unable to load lorebooks right now.');
        toastr.error('Failed to refresh the Lorebook Manager.');
    } finally {
        if (showLoader) {
            setLoading(false);
        }
    }
}

async function hydrateEntryCounts(lorebooks, refreshToken) {
    const updates = await Promise.all(lorebooks.map(async (record) => {
        try {
            const data = await loadWorldInfo(record.apiName);
            return [record.apiName, getLorebookEntryCount(data)];
        } catch (error) {
            console.warn(`[Lorebook Manager] Failed to load lorebook "${record.apiName}" for count`, error);
            return [record.apiName, null];
        }
    }));

    if (refreshToken !== state.refreshToken) {
        return;
    }

    updates.forEach(([apiName, entryCount]) => {
        if (typeof entryCount === 'number') {
            state.entryCounts[apiName] = entryCount;
        }
    });

    state.lorebooks = state.lorebooks.map(record => ({
        ...record,
        entryCount: Object.hasOwn(state.entryCounts, record.apiName) ? state.entryCounts[record.apiName] : record.entryCount,
    }));

    renderManager();
}

function getLorebookEntryCount(data) {
    if (!isObject(data) || !isObject(data.entries)) {
        return 0;
    }

    return Object.keys(data.entries).length;
}

function renderManager() {
    if (!state.dom.modal || !state.isOpen) {
        return;
    }

    renderFolderTree();
    renderLorebookGrid();
    renderHeaderState();
}

function renderHeaderState() {
    if (!state.dom.breadcrumb || !state.dom.summary) {
        return;
    }

    switch (state.activeFolderId) {
        case SPECIAL_FOLDERS.UNFILED:
            state.dom.breadcrumb.textContent = 'No Folder';
            break;
        case SPECIAL_FOLDERS.ALL:
            state.dom.breadcrumb.textContent = 'All lorebooks';
            break;
        default:
            state.dom.breadcrumb.textContent = getFolderPathLabel(state.activeFolderId);
            break;
    }

    const visible = getVisibleLorebooks().length;
    const totalPages = clampCurrentPage(visible);
    state.dom.summary.textContent = `${visible} shown / ${state.lorebooks.length} total`;
    state.dom.newSubfolder.disabled = !Boolean(getSelectedRealFolderId());
    state.dom.pageSize.value = String(state.pageSize);

    if (state.dom.pageControls && state.dom.pageLabel && state.dom.prevPage && state.dom.nextPage) {
        const hasPagination = visible > 0;
        state.dom.pageControls.classList.toggle('lmb_hidden', !hasPagination);
        state.dom.pageLabel.textContent = `Page ${state.currentPage} of ${totalPages}`;
        state.dom.prevPage.disabled = state.currentPage <= 1;
        state.dom.nextPage.disabled = state.currentPage >= totalPages;
    }
}

function renderFolderTree() {
    const tree = state.dom.folderTree;
    if (!tree) {
        return;
    }

    tree.innerHTML = '';

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.ALL,
        label: 'All Lorebooks',
        count: state.lorebooks.length,
        iconClass: 'fa-layer-group',
        selectable: true,
        dropTarget: false,
    }));

    tree.appendChild(createVirtualFolderRow({
        id: SPECIAL_FOLDERS.UNFILED,
        label: 'No Folder',
        count: countUnfiledLorebooks(),
        iconClass: 'fa-inbox',
        selectable: true,
        dropTarget: true,
    }));

    getSortedFolders().forEach(folder => {
        tree.appendChild(createFolderBranch(folder));
    });
}

function createVirtualFolderRow({ id, label, count, iconClass, selectable, dropTarget }) {
    const row = document.createElement('div');
    row.className = 'lmb_virtual_row';
    if (state.activeFolderId === id) {
        row.classList.add('is-selected');
    }

    if (dropTarget) {
        row.dataset.lmbDropTarget = id;
        row.classList.add('lmb_folder_target');
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_virtual_button';
    button.dataset.lmbFolderAction = selectable ? 'select-special' : '';
    button.dataset.folderId = id;

    const icon = document.createElement('i');
    icon.className = `fa-solid ${iconClass}`;

    const labelWrap = document.createElement('span');
    labelWrap.className = 'lmb_folder_label';

    const name = document.createElement('span');
    name.className = 'lmb_folder_name';
    name.textContent = label;

    const countElement = document.createElement('span');
    countElement.className = 'lmb_folder_count';
    countElement.textContent = `${count}`;

    labelWrap.append(icon, name, countElement);
    button.appendChild(labelWrap);
    row.appendChild(button);
    return row;
}

function createFolderBranch(folder) {
    const branch = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'lmb_folder_row lmb_folder_target';
    row.dataset.folderId = folder.id;
    row.dataset.lmbDropTarget = folder.id;

    if (state.activeFolderId === folder.id) {
        row.classList.add('is-selected');
    }

    const children = getSortedFolders(folder.id);
    const hasChildren = children.length > 0;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'lmb_folder_toggle';
    toggle.dataset.lmbFolderAction = 'toggle-folder';
    toggle.dataset.folderId = folder.id;
    toggle.title = folder.collapsed ? 'Expand folder' : 'Collapse folder';
    toggle.innerHTML = hasChildren
        ? `<i class="fa-solid ${folder.collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>`
        : '<i class="fa-solid fa-minus"></i>';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_folder_button';
    button.dataset.lmbFolderAction = 'select-folder';
    button.dataset.folderId = folder.id;

    const labelWrap = document.createElement('span');
    labelWrap.className = 'lmb_folder_label';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${folder.collapsed ? 'fa-folder' : 'fa-folder-open'}`;

    const name = document.createElement('span');
    name.className = 'lmb_folder_name';
    name.textContent = folder.name;

    const count = document.createElement('span');
    count.className = 'lmb_folder_count';
    count.textContent = `${countLorebooksForFolder(folder.id)}`;

    labelWrap.append(icon, name, count);
    button.appendChild(labelWrap);

    const tools = document.createElement('div');
    tools.className = 'lmb_folder_tools';
    tools.append(
        createFolderToolButton('new-subfolder', folder.id, 'New subfolder', 'fa-folder-plus'),
        createFolderToolButton('rename-folder', folder.id, 'Rename folder', 'fa-pencil'),
        createFolderToolButton('delete-folder', folder.id, 'Delete folder', 'fa-trash-can'),
    );

    row.append(toggle, button, tools);
    branch.appendChild(row);

    if (hasChildren && !folder.collapsed) {
        const childContainer = document.createElement('div');
        childContainer.className = 'lmb_folder_children';
        children.forEach(child => childContainer.appendChild(createFolderBranch(child)));
        branch.appendChild(childContainer);
    }

    return branch;
}

function createFolderToolButton(action, folderId, title, iconClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmb_folder_tool';
    button.dataset.lmbFolderAction = action;
    button.dataset.folderId = folderId;
    button.title = title;
    button.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    return button;
}

function renderLorebookGrid() {
    const grid = state.dom.grid;
    if (!grid) {
        return;
    }

    const visibleLorebooks = getVisibleLorebooks();
    const visibleOnPage = getLorebooksOnCurrentPage(visibleLorebooks);
    grid.innerHTML = '';

    if (!visibleLorebooks.length) {
        setEmptyMessage(state.isLoading ? '' : 'No lorebooks match this view yet.');
        return;
    }

    setEmptyMessage('');
    visibleOnPage.forEach(record => grid.appendChild(createLorebookCard(record)));
}

function getLorebooksOnCurrentPage(visibleLorebooks) {
    const totalPages = clampCurrentPage(visibleLorebooks.length);
    if (!visibleLorebooks.length) {
        state.currentPage = 1;
        return [];
    }

    const pageNumber = Math.min(state.currentPage, totalPages);
    const startIndex = (pageNumber - 1) * state.pageSize;
    return visibleLorebooks.slice(startIndex, startIndex + state.pageSize);
}

function createLorebookCard(record) {
    const card = document.createElement('article');
    card.className = 'lmb_card';
    card.draggable = true;
    card.dataset.bookName = record.apiName;

    const cover = document.createElement('div');
    cover.className = 'lmb_card_cover';
    cover.dataset.lmbBookAction = 'open';
    cover.title = `Open ${record.displayName}`;
    if (record.coverPath) {
        const image = document.createElement('img');
        image.src = toClientImagePath(record.coverPath);
        image.alt = `${record.displayName} cover`;
        cover.appendChild(image);
    }

    const fallback = document.createElement('div');
    fallback.className = 'lmb_cover_fallback';
    if (record.coverPath) {
        fallback.classList.add('lmb_hidden');
    }
    fallback.innerHTML = '<i class="fa-solid fa-book-atlas"></i>';
    cover.appendChild(fallback);

    const badges = document.createElement('div');
    badges.className = 'lmb_card_badges';
    if (selected_world_info.includes(record.apiName)) {
        badges.appendChild(createBadge('Global', 'fa-globe'));
    }
    if (record.folderId) {
        badges.appendChild(createBadge('Filed', 'fa-folder-open'));
    }
    cover.appendChild(badges);

    const body = document.createElement('div');
    body.className = 'lmb_card_body';

    const titleRow = document.createElement('div');
    titleRow.className = 'lmb_card_title_row';

    const title = document.createElement('h3');
    title.className = 'lmb_card_title';
    title.textContent = record.displayName;

    const count = document.createElement('span');
    count.className = 'lmb_card_count';
    count.textContent = typeof record.entryCount === 'number'
        ? `${record.entryCount} entries`
        : 'Counting entries';

    titleRow.append(title, count);

    const meta = document.createElement('p');
    meta.className = 'lmb_card_meta';
    meta.textContent = getFolderPathLabel(record.folderId);

    body.append(titleRow, meta);

    if (record.displayName !== record.apiName) {
        const fileMeta = document.createElement('p');
        fileMeta.className = 'lmb_card_meta';
        fileMeta.textContent = `File: ${record.apiName}`;
        body.appendChild(fileMeta);
    }

    const actions = document.createElement('div');
    actions.className = 'lmb_card_actions';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'menu_button menu_button_icon interactable lmb_card_open';
    openButton.dataset.lmbBookAction = 'open';
    openButton.innerHTML = '<i class="fa-solid fa-book-open"></i><span>Open</span>';

    const folderSelect = document.createElement('select');
    folderSelect.className = 'text_pole textarea_compact lmb_card_folder_select';
    folderSelect.dataset.lmbField = 'folder';
    folderSelect.dataset.bookName = record.apiName;
    folderSelect.title = `Move "${record.displayName}" to a folder`;
    folderSelect.appendChild(new Option('No Folder', ''));
    buildFolderOptions().forEach(option => folderSelect.appendChild(option));
    folderSelect.value = record.folderId || '';

    const renameButton = createCardIconButton('rename', 'Rename with the built-in editor', 'fa-pencil');
    const coverButton = createCardIconButton('upload-cover', 'Upload or replace cover', 'fa-image');
    const clearCoverButton = createCardIconButton('clear-cover', 'Remove cover', 'fa-circle-xmark');
    clearCoverButton.setAttribute('aria-label', 'Remove cover');
    if (!record.coverPath) {
        clearCoverButton.classList.add('lmb_hidden');
    }
    const deleteButton = createCardIconButton('delete', 'Delete lorebook', 'fa-trash-can');
    const toolRow = document.createElement('div');
    toolRow.className = 'lmb_card_tool_row';
    toolRow.append(renameButton, coverButton, clearCoverButton, deleteButton);

    actions.append(openButton, folderSelect, toolRow);
    card.append(cover, body, actions);
    return card;
}

function createBadge(label, iconClass) {
    const badge = document.createElement('span');
    badge.className = 'lmb_badge';
    badge.innerHTML = `<i class="fa-solid ${iconClass}"></i><span>${label}</span>`;
    return badge;
}

function createCardIconButton(action, title, iconClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button menu_button_icon interactable lmb_card_icon_button';
    button.dataset.lmbBookAction = action;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = `<i class="fa-solid ${iconClass}"></i>`;
    return button;
}

function buildFolderOptions() {
    const options = [];

    const appendOptions = (folder, depth) => {
        const prefix = depth > 0 ? `${'| '.repeat(depth)}- ` : '';
        options.push(new Option(`${prefix}${folder.name}`, folder.id));
        getSortedFolders(folder.id).forEach(child => appendOptions(child, depth + 1));
    };

    getSortedFolders().forEach(folder => appendOptions(folder, 0));
    return options;
}

async function onCreateLorebookClick() {
    const defaultName = getFreeWorldName('Lorebook');
    const finalName = await Popup.show.input('Create a new Lorebook', 'Enter a name for the new lorebook:', defaultName);
    if (!finalName) {
        return;
    }

    const created = await createNewWorldInfo(finalName, { interactive: true });
    if (!created) {
        return;
    }

    const folderId = getSelectedRealFolderId();
    if (folderId) {
        await moveLorebookToFolder(finalName, folderId, { silent: true });
    }

    await refreshLorebooks({ showLoader: false });
    toastr.success(`Lorebook "${finalName}" created.`);
}

async function onImportInputChange(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';

    if (!file) {
        return;
    }

    const before = new Set(state.lorebooks.map(record => record.apiName));
    await importWorldInfo(file);
    await refreshLorebooks({ showLoader: false });

    const imported = state.lorebooks.filter(record => !before.has(record.apiName));
    const folderId = getSelectedRealFolderId();
    if (imported.length === 1 && folderId) {
        await moveLorebookToFolder(imported[0].apiName, folderId, { silent: true });
    }

    if (imported.length === 1) {
        toastr.success(`Imported "${imported[0].displayName}".`);
    }
}

async function onCoverInputChange(event) {
    const input = event.target;
    const file = input.files?.[0];
    input.value = '';

    const apiName = state.pendingCoverTarget;
    state.pendingCoverTarget = '';

    if (!file || !apiName) {
        return;
    }

    try {
        const normalizedFile = await ensureImageFormatSupported(file);
        const dataUrl = await getBase64Async(normalizedFile);
        const base64 = dataUrl.split(',')[1];
        const extension = getFileExtension(normalizedFile);
        const stableId = await ensureStableLorebookId(apiName);
        const coverPath = await saveBase64AsFile(base64, IMAGE_SUBFOLDER, `${stableId}-cover`, extension);
        const meta = await mutateLorebookMeta(apiName, current => ({ ...current, coverPath }));
        applyLorebookMetaToState(apiName, meta);
        renderManager();
        toastr.success('Lorebook cover updated.');
    } catch (error) {
        console.error('[Lorebook Manager] Failed to upload cover', error);
        toastr.error('Failed to upload the cover image.');
    }
}

function getFileExtension(file) {
    if (file.type?.includes('/')) {
        return file.type.split('/')[1].toLowerCase();
    }

    const match = String(file.name || '').match(/\.([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() || 'png';
}

async function onFolderTreeClick(event) {
    const actionElement = event.target.closest('[data-lmb-folder-action]');
    if (!actionElement) {
        return;
    }

    const action = actionElement.dataset.lmbFolderAction;
    const folderId = actionElement.dataset.folderId || '';

    switch (action) {
        case 'select-special':
            setActiveFolder(folderId);
            break;
        case 'select-folder':
            setActiveFolder(folderId);
            break;
        case 'toggle-folder':
            toggleFolderCollapsed(folderId);
            break;
        case 'new-subfolder':
            openCreateFolderPrompt(folderId);
            break;
        case 'rename-folder':
            openRenameFolderPrompt(folderId);
            break;
        case 'delete-folder':
            await deleteFolderAndReassign(folderId);
            break;
        default:
            break;
    }
}

function onFolderTreeDragOver(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    if (!target) {
        return;
    }

    event.preventDefault();
    clearDropTargetStyles();
    target.classList.add('is-drop-target');
}

function onFolderTreeDragLeave(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    if (!target) {
        return;
    }

    target.classList.remove('is-drop-target');
}

async function onFolderTreeDrop(event) {
    const target = event.target.closest('[data-lmb-drop-target]');
    const apiName = event.dataTransfer?.getData('text/lorebook-name');

    clearDropTargetStyles();

    if (!target || !apiName) {
        return;
    }

    event.preventDefault();

    const rawTarget = target.dataset.lmbDropTarget;
    const folderId = rawTarget === SPECIAL_FOLDERS.UNFILED ? null : rawTarget;
    await moveLorebookToFolder(apiName, folderId);
}

function clearDropTargetStyles() {
    state.dom.folderTree?.querySelectorAll('.is-drop-target').forEach(node => node.classList.remove('is-drop-target'));
}

async function onLorebookGridClick(event) {
    const actionElement = event.target.closest('[data-lmb-book-action]');
    if (!actionElement) {
        return;
    }

    const card = actionElement.closest('.lmb_card');
    const apiName = card?.dataset.bookName || '';
    if (!apiName) {
        return;
    }

    switch (actionElement.dataset.lmbBookAction) {
        case 'open':
            closeManager();
            openWorldInfoEditor(apiName);
            break;
        case 'rename':
            closeManager();
            openWorldInfoEditor(apiName);
            requestAnimationFrame(() => {
                setTimeout(() => {
                    document.getElementById('world_popup_name_button')?.click();
                }, 75);
            });
            break;
        case 'upload-cover':
            state.pendingCoverTarget = apiName;
            state.dom.coverInput.click();
            break;
        case 'clear-cover':
            await clearLorebookCover(apiName);
            break;
        case 'delete':
            await deleteLorebookWithCover(apiName);
            break;
        default:
            break;
    }
}

async function onLorebookGridChange(event) {
    const select = event.target.closest('[data-lmb-field="folder"]');
    if (!select) {
        return;
    }

    const apiName = select.dataset.bookName || '';
    if (!apiName) {
        return;
    }

    await moveLorebookToFolder(apiName, select.value || null);
}

function onLorebookDragStart(event) {
    const card = event.target.closest('.lmb_card');
    if (!card || !event.dataTransfer) {
        return;
    }

    event.dataTransfer.setData('text/lorebook-name', card.dataset.bookName || '');
    card.classList.add('is-dragging');
}

function onLorebookDragEnd(event) {
    const card = event.target.closest('.lmb_card');
    card?.classList.remove('is-dragging');
}

function onCoverImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) {
        return;
    }

    const cover = image.closest('.lmb_card_cover');
    cover?.classList.add('is-broken');
    cover?.querySelector('.lmb_cover_fallback')?.classList.remove('lmb_hidden');
}

function toggleFolderCollapsed(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    folder.collapsed = !folder.collapsed;
    saveManagerSettings();
    renderManager();
}

async function openCreateFolderPrompt(parentId) {
    const parentLabel = parentId ? getFolderPathLabel(parentId) : 'root';
    const name = await Popup.show.input('Create folder', `Enter a name for the folder in ${parentLabel}:`, '');
    if (!name || !name.trim()) {
        return;
    }

    const folder = {
        id: getContext().uuidv4(),
        name: name.trim(),
        parentId: parentId || null,
        collapsed: false,
        sortOrder: Date.now(),
    };

    getFolders().push(folder);
    saveManagerSettings();
    setActiveFolder(folder.id);
}

async function openRenameFolderPrompt(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    const nextName = await Popup.show.input('Rename folder', 'Enter a new folder name:', folder.name);
    if (!nextName || !nextName.trim()) {
        return;
    }

    folder.name = nextName.trim();
    saveManagerSettings();
    renderManager();
}

async function deleteFolderAndReassign(folderId) {
    const folder = getFolderById(folderId);
    if (!folder) {
        return;
    }

    const assignedLorebooks = state.lorebooks.filter(record => record.folderId === folderId);
    const confirmed = await Popup.show.confirm(
        `Delete folder "${folder.name}"?`,
        `Subfolders move up one level and ${assignedLorebooks.length} lorebook(s) will move to ${folder.parentId ? getFolderPathLabel(folder.parentId) : 'No Folder'}.`,
    );

    if (!confirmed) {
        return;
    }

    getFolders().forEach(candidate => {
        if (candidate.parentId === folderId) {
            candidate.parentId = folder.parentId || null;
        }
    });

    const settings = getManagerSettings();
    settings.folders = settings.folders.filter(candidate => candidate.id !== folderId);
    if (state.activeFolderId === folderId) {
        settings.activeFolderId = folder.parentId || SPECIAL_FOLDERS.ALL;
        state.activeFolderId = settings.activeFolderId;
    }
    saveManagerSettings();

    for (const record of assignedLorebooks) {
        await moveLorebookToFolder(record.apiName, folder.parentId || null, { silent: true });
    }

    renderManager();
}

async function moveLorebookToFolder(apiName, folderId, { silent = false } = {}) {
    try {
        const folder = folderId ? getFolderById(folderId) : null;
        const normalizedFolderId = folder ? folder.id : null;
        const current = findLorebook(apiName);

        if (current && current.folderId === normalizedFolderId) {
            return;
        }

        const meta = await mutateLorebookMeta(apiName, existing => ({
            ...existing,
            folderId: normalizedFolderId || '',
        }));

        applyLorebookMetaToState(apiName, meta);
        renderManager();

        if (!silent) {
            toastr.success(normalizedFolderId ? `Moved to ${getFolderPathLabel(normalizedFolderId)}.` : 'Moved to No Folder.');
        }
    } catch (error) {
        console.error('[Lorebook Manager] Failed to move lorebook', error);
        toastr.error('Failed to move the lorebook.');
    }
}

async function ensureStableLorebookId(apiName) {
    const record = findLorebook(apiName);
    if (record?.bookId) {
        return record.bookId;
    }

    const meta = await mutateLorebookMeta(apiName, current => current);
    applyLorebookMetaToState(apiName, meta);
    return meta.bookId;
}

async function mutateLorebookMeta(apiName, updater) {
    const data = await loadWorldInfo(apiName);
    if (!isObject(data)) {
        throw new Error(`Lorebook "${apiName}" could not be loaded.`);
    }

    if (!isObject(data.extensions)) {
        data.extensions = {};
    }

    const existing = getLorebookMetaFromData(data);
    const draft = {
        bookId: existing.bookId || getContext().uuidv4(),
        folderId: existing.folderId || '',
        coverPath: existing.coverPath || '',
    };

    const next = updater ? updater({ ...draft }) : draft;
    const cleaned = cleanLorebookMeta(next);

    if (cleaned) {
        data.extensions[LOREBOOK_META_KEY] = cleaned;
    } else {
        delete data.extensions[LOREBOOK_META_KEY];
    }

    await saveWorldInfo(apiName, data, true);
    return cleaned || {};
}

async function clearLorebookCover(apiName) {
    const record = findLorebook(apiName);
    if (!record?.coverPath) {
        return;
    }

    const confirmed = await Popup.show.confirm(`Remove the cover for "${record.displayName}"?`, '');
    if (!confirmed) {
        return;
    }

    try {
        await deleteCoverAsset(record.coverPath);
    } catch (error) {
        console.warn('[Lorebook Manager] Failed to delete cover asset before clearing metadata', error);
    }

    try {
        const meta = await mutateLorebookMeta(apiName, current => ({
            ...current,
            coverPath: '',
        }));

        applyLorebookMetaToState(apiName, meta);
        renderManager();
        toastr.success('Lorebook cover removed.');
    } catch (error) {
        console.error('[Lorebook Manager] Failed to clear lorebook cover metadata', error);
        toastr.error('Failed to remove the lorebook cover.');
    }
}

async function deleteCoverAsset(coverPath) {
    if (!coverPath) {
        return;
    }

    const response = await fetch('/api/images/delete', {
        method: 'POST',
        headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ path: coverPath }),
    });

    if (!response.ok) {
        throw new Error(`Failed to delete cover asset (${response.status})`);
    }
}

async function deleteLorebookWithCover(apiName) {
    const record = findLorebook(apiName);
    if (!record) {
        return;
    }

    const confirmed = await Popup.show.confirm(`Delete lorebook "${record.displayName}"?`, 'This also removes its manager cover if one is set.');
    if (!confirmed) {
        return;
    }

    if (record.coverPath) {
        try {
            await deleteCoverAsset(record.coverPath);
        } catch (error) {
            console.warn('[Lorebook Manager] Failed to delete lorebook cover asset', error);
        }
    }

    const deleted = await deleteWorldInfo(apiName);
    if (!deleted) {
        toastr.error('Failed to delete the lorebook.');
        return;
    }

    await refreshLorebooks({ showLoader: false });
    toastr.success(`Deleted "${record.displayName}".`);
}

function scheduleRefresh(delay = 120) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
        if (!state.isOpen) {
            return;
        }

        refreshLorebooks({ showLoader: false });
    }, delay);
}

function placeToolbarButton(toolbarRow, button, beforeNode = null) {
    if (!(toolbarRow instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        return;
    }

    if (beforeNode instanceof HTMLElement) {
        if (button.parentElement === toolbarRow && button.nextElementSibling === beforeNode) {
            return;
        }

        toolbarRow.insertBefore(button, beforeNode);
        return;
    }

    if (button.parentElement === toolbarRow && toolbarRow.lastElementChild === button) {
        return;
    }

    toolbarRow.appendChild(button);
}

function injectManagerButton() {
    const toolbarRow = document.querySelector('#world_popup .flex-container');
    if (!toolbarRow) {
        return;
    }

    const deleteButton = document.getElementById('world_popup_delete');
    let coverButton = document.getElementById('lorebook_cover_button');
    if (!coverButton) {
        coverButton = document.createElement('div');
        coverButton.id = 'lorebook_cover_button';
        coverButton.className = 'menu_button menu_button_icon interactable';
        coverButton.setAttribute('role', 'button');
        coverButton.setAttribute('tabindex', '0');
        coverButton.setAttribute('aria-label', 'Set a lorebook cover');
        coverButton.innerHTML = '<i class="fa-solid fa-image"></i>';
        coverButton.addEventListener('click', onCurrentLorebookCoverClick);
    }

    let managerButton = document.getElementById('lorebook_manager_button');
    if (!managerButton) {
        managerButton = document.createElement('div');
        managerButton.id = 'lorebook_manager_button';
        managerButton.className = 'menu_button menu_button_icon interactable';
        managerButton.title = 'Open Lorebook Manager';
        managerButton.setAttribute('role', 'button');
        managerButton.setAttribute('aria-label', 'Open Lorebook Manager');
        managerButton.setAttribute('tabindex', '0');
        managerButton.innerHTML = '<i class="fa-solid fa-folder-tree"></i><span>Manager</span>';
        managerButton.addEventListener('click', openManager);
    }

    if (deleteButton?.parentElement === toolbarRow) {
        placeToolbarButton(toolbarRow, managerButton, deleteButton);
        placeToolbarButton(toolbarRow, coverButton, managerButton);
    } else {
        placeToolbarButton(toolbarRow, coverButton);
        placeToolbarButton(toolbarRow, managerButton);
    }

    updateWorldToolbarButtons();
}

function startButtonObserver() {
    if (state.buttonObserver) {
        return;
    }

    state.buttonObserver = new MutationObserver(() => {
        injectManagerButton();
        startWorldListObserver();
    });

    state.buttonObserver.observe(document.body, { childList: true, subtree: true });
    injectManagerButton();
    startWorldListObserver();
}

function startWorldListObserver() {
    if (state.worldListObserver) {
        return;
    }

    const worldSelect = document.getElementById('world_editor_select');
    if (!worldSelect) {
        return;
    }

    if (!worldSelect.dataset.lmbBound) {
        worldSelect.addEventListener('change', updateWorldToolbarButtons);
        worldSelect.dataset.lmbBound = 'true';
    }

    state.worldListObserver = new MutationObserver(() => {
        scheduleRefresh();
        updateWorldToolbarButtons();
    });

    state.worldListObserver.observe(worldSelect, { childList: true, subtree: true });
}

function handleWorldInfoUpdated(apiName, data) {
    const entryCount = getLorebookEntryCount(data);
    state.entryCounts[apiName] = entryCount;

    const meta = getLorebookMetaFromData(data);
    const existing = findLorebook(apiName);
    if (existing) {
        applyLorebookMetaToState(apiName, meta);
        state.lorebooks = state.lorebooks.map(record => record.apiName === apiName
            ? { ...record, entryCount }
            : record);
        updateWorldToolbarButtons();
        renderManager();
    } else {
        scheduleRefresh();
    }
}

function getCurrentEditorLorebookName() {
    const select = document.getElementById('world_editor_select');
    if (!(select instanceof HTMLSelectElement)) {
        return '';
    }

    const selectedOption = select.options[select.selectedIndex];
    if (!selectedOption || selectedOption.value === '') {
        return '';
    }

    return selectedOption.textContent?.trim() || '';
}

function updateWorldToolbarButtons() {
    const coverButton = document.getElementById('lorebook_cover_button');
    if (!coverButton) {
        return;
    }

    const apiName = getCurrentEditorLorebookName();
    const record = apiName ? findLorebook(apiName) : null;
    const hasCover = Boolean(record?.coverPath);
    const title = apiName
        ? (hasCover
            ? `Set or replace the cover for "${record?.displayName || apiName}". Shift-click to remove the current cover.`
            : `Set a cover for "${record?.displayName || apiName}".`)
        : 'Open a lorebook to set a cover.';

    coverButton.title = title;
    coverButton.setAttribute('aria-label', title);
    coverButton.classList.toggle('is-disabled', !apiName);
    coverButton.classList.toggle('has-cover', hasCover);
}

async function onCurrentLorebookCoverClick(event) {
    const apiName = getCurrentEditorLorebookName();
    if (!apiName) {
        toastr.info('Open a lorebook first.');
        return;
    }

    const record = findLorebook(apiName);
    if ((event.shiftKey || event.altKey) && record?.coverPath) {
        await clearLorebookCover(apiName);
        updateWorldToolbarButtons();
        return;
    }

    await ensureManagerDom();
    state.pendingCoverTarget = apiName;
    state.dom.coverInput.click();
}

function collapseWorldInfoDrawer() {
    const drawer = document.getElementById('WorldInfo');
    if (drawer?.classList.contains('closedDrawer')) {
        return;
    }

    document.getElementById('WIDrawerIcon')?.click();
}

function initialize() {
    if (state.initialized) {
        return;
    }

    state.initialized = true;

    const settings = getManagerSettings();
    state.activeFolderId = settings.activeFolderId;
    state.sort = settings.sort;
    state.pageSize = settings.pageSize;

    startButtonObserver();

    const context = getContext();
    context.eventSource.on(context.eventTypes.WORLDINFO_UPDATED, handleWorldInfoUpdated);
    context.eventSource.on(context.eventTypes.WORLDINFO_SETTINGS_UPDATED, () => {
        renderManager();
    });
}

if (document.readyState === 'complete') {
    initialize();
} else {
    window.addEventListener('load', initialize, { once: true });
}
