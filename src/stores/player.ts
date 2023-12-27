import { ref } from "vue";
import { defineStore } from "pinia";

import useTabs from "./tabs";
import useQueue from "./queue";
import useLyrics from "./lyrics";
import useColors from "./colors";
import useTracker from "./tracker";
import useSettings from "./settings";
import useTracklist from "./queue/tracklist";
import { NotifType, useNotifStore } from "./notification";

import { paths } from "../config";
import updateMediaNotif from "@/helpers/mediaNotification";

function getUrl(filepath: string, trackhash: string) {
  return `${paths.api.files}/${trackhash}?filepath=${encodeURIComponent(
    filepath
  )}`;
}

function crossFade(
  audio: HTMLAudioElement,
  duration = 1000,
  start_volume = 0,
  then_destroy = false
) {
  if (audio.muted || duration < 1000) {
    return;
  }

  const { volume } = useSettings();

  audio.volume = start_volume;
  const fadeStepTime = 50;
  const fadeSteps = duration / fadeStepTime;
  const volumeStep = volume / fadeSteps;
  const is_up = start_volume == 0;

  function incrementOrDecrement() {
    const v = audio.volume;
    const newVolume = is_up ? v + volumeStep : v - volumeStep;

    if (newVolume > 1) {
      audio.volume = 1;
      return;
    }

    if (newVolume < 0) {
      audio.volume = 0;
      return;
    }

    audio.volume = newVolume;
  }

  let counter = 0;

  const interval = setInterval(() => {
    if (counter == fadeSteps) {
      return stopInterval();
    }

    incrementOrDecrement();
    counter++;
  }, fadeStepTime);

  function stopInterval() {
    clearInterval(interval);

    if (then_destroy) {
      audio.pause();
      audio.src = "";
      // @ts-ignore
      audio = null;
    }
  }
}

let audio = new Audio();

export const usePlayer = defineStore("player", () => {
  const tabs = useTabs();
  const queue = useQueue();
  const colors = useColors();
  const lyrics = useLyrics();
  const tracker = useTracker();
  const toast = useNotifStore();
  const settings = useSettings();
  const tracklist = useTracklist();

  const crossfade_duration = 2000;
  let currentAudioData = {
    filepath: "",
    silence: {
      start: 0,
      end: 0,
    },
  };

  let nextAudioData = {
    filepath: "",
    audio: new Audio(),
    loaded: false,
    ticking: false,
    silence: {
      start: 0,
      end: 0,
    },
  };

  let movingNextTimer: any = null;
  function clearMovingNextTimeout() {
    if (movingNextTimer) {
      clearTimeout(movingNextTimer);
      movingNextTimer = null;
      nextAudioData.ticking = false;
    }
  }

  function clearNextAudioData() {
    nextAudioData.filepath = "";
    nextAudioData.audio = new Audio();
    nextAudioData.loaded = false;
    nextAudioData.ticking = false;
    nextAudioData.silence = {
      start: 0,
      end: 0,
    };

    clearMovingNextTimeout();
  }

  let sourceTime = 0;
  let lastTime = 0;

  const buffering = ref(false);

  function setVolume(new_value: number) {
    audio.volume = new_value;
  }

  function setMute(new_value: boolean) {
    audio.muted = new_value;
  }

  const audio_onerror = (err: Event | string) => {
    const { showNotification } = useNotifStore();

    if (typeof err != "string") {
      err.stopImmediatePropagation();
    }

    if (err instanceof DOMException) {
      queue.playPause();

      return toast.showNotification(
        "Tap anywhere in the page and try again (autoplay blocked))",
        NotifType.Error
      );
    }

    showNotification(
      "Can't play: " + queue.currenttrack.title,
      NotifType.Error
    );

    if (queue.currentindex !== tracklist.tracklist.length - 1) {
      if (!queue.playing) return;

      // if (queue.currenttrack.trackhash !== track.trackhash) return;
      setTimeout(() => {
        queue.playNext();
      }, 3000);
      return;
    }

    // TODO: move this to a queue action
    queue.setPlaying(false);
  };

  const handlePlayErrors = (e: Event) => {
    if (e instanceof DOMException) {
      queue.playPause();

      return toast.showNotification(
        "Tap anywhere in the page and try again (autoplay blocked))",
        NotifType.Error
      );
    }

    toast.showNotification(
      "Can't play: " + queue.currenttrack.title,
      NotifType.Error
    );
  };

  const runActionsOnPlay = () => {
    if (
      !queue.manual &&
      !audio.src.includes("sm.radio.jingles") &&
      audio.currentTime - currentAudioData.silence.start / 1000 <= 4
    ) {
      crossFade(audio, crossfade_duration, 0);
    }

    updateMediaNotif();
    colors.setTheme1Color(paths.images.thumb.small + queue.currenttrack.image);

    if (tabs.nowplaying == tabs.tabs.lyrics) {
      return lyrics.getLyrics();
    }

    if (!settings.use_lyrics_plugin) {
      lyrics.checkExists(
        queue.currenttrack.filepath,
        queue.currenttrack.trackhash
      );
    }
  };

  const onAudioCanPlay = () => {
    if (!queue.playing) {
      audio.pause();
      return;
    }
    queue.setDurationFromFile(audio.duration);

    audio.play().catch(handlePlayErrors);
  };

  const onAudioEnded = () => {
    const { submitData, setTimestamp } = tracker;
    submitData();
    setTimestamp();
    queue.autoPlayNext();
  };

  const onAudioPlay = () => {
    // reset sourceTime to prevent false positives
    const date = new Date();
    sourceTime = date.getTime();

    runActionsOnPlay();
  };

  const updateLyricsPosition = () => {
    if (!lyrics.exists || tabs.nowplaying !== tabs.tabs.lyrics) return;

    const millis = Math.round(audio.currentTime * 1000);
    const diff = lyrics.nextLineTime - millis;

    if (diff < 0) {
      const line = lyrics.calculateCurrentLine();
      lyrics.setCurrentLine(line + 1, false);
      return;
    }

    if (diff < 1200) {
      // set timer to next line
      if (
        lyrics.lyrics &&
        !(lyrics.lyrics.length <= lyrics.currentLine + 1) &&
        !lyrics.ticking
      ) {
        lyrics.setNextLineTimer(diff);
      }
    }
  };

  const handleNextAudioCanPlay = async () => {
    const worker = new Worker("/workers/silence.js");

    worker.postMessage({
      ending_file: queue.currenttrack.filepath,
      starting_file: queue.next.filepath,
    });

    worker.onmessage = (e) => {
      const silence = e.data;
      nextAudioData.silence.start = silence.start;
      currentAudioData.silence.end = silence.end;
      nextAudioData.loaded = silence !== null;
    };
  };

  function loadNextTrack() {
    if (nextAudioData.filepath === queue.next.filepath) return;

    const uri = getUrl(queue.next.filepath, queue.next.trackhash);
    nextAudioData.audio = new Audio(uri);
    audio.muted = settings.mute;
    nextAudioData.filepath = queue.next.filepath;
    nextAudioData.audio.oncanplay = handleNextAudioCanPlay;
    nextAudioData.audio.load();
  }

  function moveLoadedForward() {
    clearEventHandlers(audio);

    const oldAudio = audio;
    queue.setManual(false);
    crossFade(oldAudio, crossfade_duration, settings.volume, true);

    audio = nextAudioData.audio;
    audio.currentTime = nextAudioData.silence.start / 1000;
    currentAudioData.silence = nextAudioData.silence;
    currentAudioData.filepath = nextAudioData.filepath;

    clearNextAudioData();
    queue.moveForward();
    assignEventHandlers(audio);
  }

  const initLoadingNextTrackAudio = () => {
    const currentTime = audio.currentTime;

    // if track has less than 20 seconds left, load next track
    if (Number.isNaN(audio.duration) || audio.duration - currentTime > 20) {
      return;
    }

    if (!nextAudioData.loaded) {
      loadNextTrack();
    }

    if (
      nextAudioData.loaded &&
      !nextAudioData.ticking &&
      currentAudioData.silence.end
    ) {
      const diff =
        currentAudioData.silence.end - Math.floor(audio.currentTime * 1000);

      const is_jingle =
        queue.currenttrack.filepath.includes("sm.radio.jingles");
      const newdiff =
        crossfade_duration > diff || is_jingle
          ? diff
          : diff - crossfade_duration;

      if (diff > 0) {
        nextAudioData.ticking = true;
        movingNextTimer = setTimeout(() => {
          nextAudioData.ticking = false;
          if (!queue.playing && nextAudioData.filepath == queue.next.filepath)
            return;
          moveLoadedForward();
        }, newdiff);
      }
    }
  };

  const onAudioTimeUpdateHandler = () => {
    updateLyricsPosition();
    initLoadingNextTrackAudio();
    queue.setCurrentDuration(audio.currentTime);

    const date = new Date();
    sourceTime = date.getTime();
  };

  const handleBufferingStatus = () => {
    const difference = Math.abs(sourceTime - lastTime);

    if (difference > 600 && queue.playing) {
      buffering.value = true;
      return;
    }

    buffering.value = false;
  };

  const updateBufferWatcherTime = () => {
    if (!queue.playing) return;
    const date = new Date();
    lastTime = date.getTime();
    handleBufferingStatus();
  };

  // Loader will misbehave on HMR because of multiple setInterval calls
  setInterval(() => {
    if (!queue.playing) {
      buffering.value = false;
      return;
    }

    updateBufferWatcherTime();
  }, 100);

  function playCurrentTrack() {
    clearEventHandlers(audio);

    if (
      !queue.manual &&
      queue.playing &&
      audio.src !== "" &&
      !audio.src.includes("sm.radio.jingles")
    ) {
      const oldAudio = audio;
      crossFade(oldAudio, crossfade_duration, settings.volume, true);
      audio = new Audio();
      audio.muted = settings.mute;
    }

    const { currenttrack: track } = queue;
    const uri = `${paths.api.files}/${
      track.trackhash
    }?filepath=${encodeURIComponent(track.filepath as string)}`;

    audio.src = uri;

    // when progress bar is focused, changing a track will trigger the
    // @change event which will in turn seek the current track
    // to the previous' currentTime
    document.getElementById("progress")?.blur();
    clearNextAudioData();
    assignEventHandlers(audio);
  }

  const assignEventHandlers = (audioElem: HTMLAudioElement) => {
    audioElem.onerror = audio_onerror;
    audioElem.oncanplay = onAudioCanPlay;
    audioElem.onended = onAudioEnded;
    audioElem.onplay = onAudioPlay;
    audioElem.ontimeupdate = onAudioTimeUpdateHandler;
    tracker.reassignEventListener();
  };

  const clearEventHandlers = (audioElem: HTMLAudioElement) => {
    audioElem.onerror = null;
    audioElem.oncanplay = null;
    audioElem.onended = null;
    audioElem.onplay = null;
    audioElem.ontimeupdate = null;

    // removes listener added in stores/tracker.ts
    audioElem.removeEventListener("timeupdate", () => {});
  };

  assignEventHandlers(audio);

  return {
    audio,
    buffering,
    setMute,
    setVolume,
    playCurrent: playCurrentTrack,
    clearNextAudio: clearNextAudioData,
    clearMovingNextTimeout,
  };
});

export { audio };
