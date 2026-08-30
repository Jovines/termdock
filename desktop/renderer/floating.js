const api = window.termdockDesktop;
const statusGroup = document.querySelector('#status');
const closeButton = document.querySelector('#close');
const running = document.querySelector('#running');
const review = document.querySelector('#review');
const services = document.querySelector('#services');
const runningCount = document.querySelector('#running-count');
const reviewCount = document.querySelector('#review-count');
const serviceCount = document.querySelector('#service-count');
let renderedMetricCount = 0;

function render(status) {
  running.hidden = status.runningCount === 0;
  review.hidden = status.reviewCount === 0;
  runningCount.textContent = String(status.runningCount);
  reviewCount.textContent = String(status.reviewCount);
  serviceCount.textContent = String(status.serviceCount);
  const metricCount = 1 + Number(status.runningCount > 0) + Number(status.reviewCount > 0);
  if (metricCount !== renderedMetricCount) {
    renderedMetricCount = metricCount;
    void api.setFloatingMetricCount(metricCount);
  }
  statusGroup.setAttribute('aria-label', status.tooltip);
  running.title = `循环切换到运行中的服务（${status.runningCount}）`;
  running.setAttribute('aria-label', running.title);
  review.title = `循环切换到有待办的服务（${status.reviewCount}）`;
  review.setAttribute('aria-label', review.title);
  services.title = `循环切换全部服务（${status.serviceCount}）`;
  services.setAttribute('aria-label', services.title);
  document.body.setAttribute('aria-label', status.tooltip);
}

running.addEventListener('click', () => void api.focusNextService('running'));
review.addEventListener('click', () => void api.focusNextService('review'));
services.addEventListener('click', () => void api.focusNextService('all'));

closeButton.addEventListener('click', () => {
  void api.disableFloatingWidget();
});

api.onDesktopStatus(render);
void api.desktopStatus().then(render);
