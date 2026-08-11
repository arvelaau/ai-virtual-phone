// Minimal in-memory Dexie stand-in for fixtures.
//
// `fake-indexeddb` is not a dependency, so fixtures that need to drive real storage code
// alias `dexie` to this module via jiti. It implements only the surface this repo actually
// uses (put/bulkPut/get/toArray/delete/bulkDelete/clear/where().equals()), which is enough
// to run kv-db.ts and chat-db.ts unmodified.

class StubTable {
    constructor(primaryKey) {
        this.primaryKey = primaryKey;
        this.rows = new Map();
    }
    async put(item) {
        this.rows.set(item[this.primaryKey], item);
        return item[this.primaryKey];
    }
    async bulkPut(items) {
        for (const item of items ?? []) await this.put(item);
    }
    async add(item) {
        return this.put(item);
    }
    async get(key) {
        return this.rows.get(key);
    }
    async toArray() {
        return [...this.rows.values()];
    }
    async delete(key) {
        this.rows.delete(key);
    }
    async bulkDelete(keys) {
        for (const key of keys ?? []) this.rows.delete(key);
    }
    async clear() {
        this.rows.clear();
    }
    async count() {
        return this.rows.size;
    }
    where(field) {
        const table = this;
        const collection = (predicate) => ({
            async toArray() {
                return [...table.rows.values()].filter(predicate);
            },
            async delete() {
                for (const row of [...table.rows.values()]) {
                    if (predicate(row)) table.rows.delete(row[table.primaryKey]);
                }
            },
            async count() {
                return [...table.rows.values()].filter(predicate).length;
            },
        });
        return {
            equals: (value) => collection((row) => row[field] === value),
            anyOf: (values) => collection((row) => (values ?? []).includes(row[field])),
        };
    }
}

function parsePrimaryKey(spec) {
    const first = String(spec ?? "").split(",")[0] ?? "";
    return first.replace(/^\+\+/, "").replace(/^&/, "").trim() || "id";
}

export default class DexieStub {
    constructor(name) {
        this.name = name;
        this._tables = new Map();
    }
    version() {
        const db = this;
        return {
            stores(schema) {
                for (const [tableName, spec] of Object.entries(schema ?? {})) {
                    const table = new StubTable(parsePrimaryKey(spec));
                    db._tables.set(tableName, table);
                    db[tableName] = table;
                }
                return { upgrade() { return this; } };
            },
        };
    }
    table(name) {
        return this._tables.get(name);
    }
    async open() {
        return this;
    }
    close() {}
    on() {
        return this;
    }
    async transaction(_mode, _tables, fn) {
        return typeof fn === "function" ? fn() : undefined;
    }
}
