importScripts('./schedule-core.js');

self.onmessage = function (e) {
    const { coursesSections, options } = e.data || {};
    const result = self.ScheduleCore.solveSchedules(coursesSections, options);
    self.postMessage(result);
};
