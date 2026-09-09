"use client";

import { useEffect, useState } from "react";
import type { MediaLookupSettings as MediaLookupSettingsType } from "@/lib/settings-types";
import {
    DEFAULT_MEDIA_LOOKUP_SETTINGS,
    loadMediaLookupSettings,
    saveMediaLookupSettings,
} from "@/lib/settings-storage";
import { Input } from "@/components/ui/form";

export function MediaLookupSettings() {
    const [settings, setSettings] = useState<MediaLookupSettingsType>(DEFAULT_MEDIA_LOOKUP_SETTINGS);
    const [isLoaded, setIsLoaded] = useState(false);

    useEffect(() => {
        setSettings(loadMediaLookupSettings());
        setIsLoaded(true);
    }, []);

    const update = (next: Partial<MediaLookupSettingsType>) => {
        const merged = { ...settings, ...next };
        setSettings(merged);
        saveMediaLookupSettings(merged);
    };

    if (!isLoaded) return null;

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Movies (TMDB)</p>
                <div className="menu-group p-4 flex flex-col gap-1">
                    <label className="menu-desc ml-1">TMDB API Key</label>
                    <Input
                        type="password"
                        value={settings.tmdbApiKey}
                        onChange={(event) => update({ tmdbApiKey: event.target.value })}
                        placeholder="Get a free key from themoviedb.org/settings/api"
                    />
                    <span className="menu-desc ml-1">
                        Needed to search movies and fetch their real audience reviews in the Review app.
                        Without a key, movie search and review grounding are unavailable, but book search
                        still works.
                    </span>
                </div>
            </div>
            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Books</p>
                <div className="menu-group p-4 flex flex-col gap-1">
                    <span className="menu-desc ml-1">
                        Book search uses Open Library and Google Books, both free and requiring no API key.
                    </span>
                </div>
            </div>
        </div>
    );
}
