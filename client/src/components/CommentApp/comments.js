import { initCommentApp } from './main';
import { STRINGS } from '../../config/wagtailConfig';

function initComments() {
  window.commentApp = initCommentApp();
  document.addEventListener('DOMContentLoaded', () => {
    const commentsElement = document.getElementById('comments');
    const commentsOutputElement = document.getElementById('comments-output');
    const dataElement = document.getElementById('comments-data');
    if (!commentsElement || !commentsOutputElement || !dataElement) {
      throw new Error('Comments app failed to initialise. Missing HTML element');
    }
    const data = JSON.parse(dataElement.textContent);
    window.commentApp.renderApp(
      commentsElement, commentsOutputElement, data.user, data.comments, new Map(Object.entries(data.authors)), STRINGS
    );
  });
}

function attachTabNav(tabNavElem) {
  // Attaches the commenting app to the given tab navigation element
  window.commentApp.setCurrentTab(tabNavElem.dataset.currentTab);

  tabNavElem.addEventListener('switch', (e) => {
    window.commentApp.setCurrentTab(e.detail.tab);
  });
}

function getContentPath(fieldNode) {
  // Return the total contentpath for an element as a string, in the form field.streamfield_uid.block...
  if (fieldNode.closest('data-contentpath-disabled')) {
    return '';
  }
  let element = fieldNode.closest('[data-contentpath]');
  const contentpaths = [];
  while (element !== null) {
    contentpaths.push(element.dataset.contentpath);
    element = element.parentElement.closest('[data-contentpath]');
  }
  contentpaths.reverse();
  return contentpaths.join('.');
}

/**
 * Controls the positioning of a field level comment, and the display of the button
 * used to focus and pin the attached comment
 * `getDesiredPosition` is called by the comments app to determine the height
 * at which to float the comment.
 */
class BasicFieldLevelAnnotation {
  /**
  * Create a field-level annotation
  * @param {Element} fieldNode - an element to provide the comment position
  * @param {Element} node - the button to focus/pin the comment
  * @param commentApp - the commentApp the annotation is integrating with
  */
  constructor(fieldNode, node, commentApp) {
    this.node = node;
    this.fieldNode = fieldNode;
    this.unsubscribe = null;
    this.commentApp = commentApp;
  }
  /**
  * Subscribes the annotation to update when the state of a particular comment changes,
  * and to focus that comment when clicked
  * @param {number} localId - the localId of the comment to subscribe to
  */
  subscribeToUpdates(localId) {
    const { selectFocused, selectEnabled } = this.commentApp.selectors;
    const selectComment = this.commentApp.utils.selectCommentFactory(localId);
    const store = this.commentApp.store;
    const initialState = store.getState();
    let focused = selectFocused(initialState) === localId;
    let shown = selectEnabled(initialState);
    if (focused) {
      this.onFocus();
    }
    if (shown) {
      this.show();
    }
    this.unsubscribe = store.subscribe(() => {
      const state = store.getState();
      const comment = selectComment(state);
      if (!comment) {
        this.onDelete();
      }
      const nowFocused = (selectFocused(state) === localId);
      if (nowFocused !== focused) {
        if (focused) {
          this.onUnfocus();
        } else {
          this.onFocus();
        }
        focused = nowFocused;
      }
      if (shown !== selectEnabled(state)) {
        if (shown) {
          this.hide();
        } else {
          this.show();
        }
        shown = selectEnabled(state);
      }
    }
    );
    this.setOnClickHandler(localId);
  }
  onDelete() {
    this.node.remove();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
  }
  onFocus() {
    this.node.classList.remove('button-secondary');
    this.node.ariaLabel = STRINGS.UNFOCUS_COMMENT;
  }
  onUnfocus() {
    this.node.classList.add('button-secondary');
    this.node.ariaLabel = STRINGS.FOCUS_COMMENT;
    // TODO: ensure comment is focused accessibly when this is clicked,
    // and that screenreader users can return to the annotation point when desired
  }
  show() {
    this.node.classList.remove('u-hidden');
  }
  hide() {
    this.node.classList.add('u-hidden');
  }
  setOnClickHandler(localId) {
    this.node.addEventListener('click', () => {
      this.commentApp.store.dispatch(
        this.commentApp.actions.setFocusedComment(localId, { updatePinnedComment: true })
      );
    });
  }
  getTab() {
    return this.fieldNode.closest('section[data-tab]')?.getAttribute('data-tab');
  }
  getDesiredPosition() {
    return (
      this.fieldNode.getBoundingClientRect().top +
      document.documentElement.scrollTop
    );
  }
}

class FieldLevelCommentWidget {
  constructor({
    fieldNode,
    commentAdditionNode,
    annotationTemplateNode,
    commentApp
  }) {
    this.fieldNode = fieldNode;
    this.contentpath = getContentPath(fieldNode);
    this.commentAdditionNode = commentAdditionNode;
    this.annotationTemplateNode = annotationTemplateNode;
    this.shown = false;
    this.commentApp = commentApp;
  }
  register() {
    const { selectEnabled } = this.commentApp.selectors;
    const initialState = this.commentApp.store.getState();
    let currentlyEnabled = selectEnabled(initialState);
    const selectCommentsForContentPath = this.commentApp.utils.selectCommentsForContentPathFactory(
      this.contentpath
    );
    let currentComments = selectCommentsForContentPath(initialState);
    this.updateVisibility(currentComments.length === 0 && currentlyEnabled);
    const unsubscribeWidget = this.commentApp.store.subscribe(() => {
      const state = this.commentApp.store.getState();
      const newComments = selectCommentsForContentPath(state);
      const newEnabled = selectEnabled(state);
      const commentsChanged = (currentComments !== newComments);
      const enabledChanged = (currentlyEnabled !== newEnabled);
      if (commentsChanged) {
        // Add annotations for any new comments
        currentComments = newComments;
        currentComments.filter((comment) => comment.annotation === null).forEach((comment) => {
          const annotation = this.getAnnotationForComment(comment);
          this.commentApp.updateAnnotation(
            annotation,
            comment.localId
          );
          annotation.subscribeToUpdates(comment.localId);
        });
      }
      if (enabledChanged || commentsChanged) {
        // If comments have been enabled or disabled, or the comments have changed
        // check whether to show the widget (if comments are enabled and there are no existing comments)
        currentlyEnabled = newEnabled;
        this.updateVisibility(currentComments.length === 0 && currentlyEnabled);
      }
    });
    initialState.comments.comments.forEach((comment) => {
      // Add annotations for any comments already in the store
      if (comment.contentpath === this.contentpath) {
        const annotation = this.getAnnotationForComment(comment);
        this.commentApp.updateAnnotation(annotation, comment.localId);
        annotation.subscribeToUpdates(comment.localId);
      }
    });
    this.commentAdditionNode.addEventListener('click', () => {
      // Make the widget button clickable to add a comment
      const annotation = this.getAnnotationForComment();
      const localId = this.commentApp.makeComment(annotation, this.contentpath);
      annotation.subscribeToUpdates(localId);
    });
    return unsubscribeWidget; // TODO: listen for widget deletion and use this
  }
  updateVisibility(newShown) {
    if (newShown === this.shown) {
      return;
    }
    this.shown = newShown;

    if (!this.shown) {
      this.commentAdditionNode.classList.add('u-hidden');
    } else {
      this.commentAdditionNode.classList.remove('u-hidden');
    }
  }
  getAnnotationForComment() {
    const annotationNode = this.annotationTemplateNode.cloneNode(true);
    annotationNode.id = '';
    annotationNode.classList.remove('u-hidden');
    this.commentAdditionNode.insertAdjacentElement('afterend', annotationNode);
    return new BasicFieldLevelAnnotation(this.fieldNode, annotationNode, this.commentApp);
  }
}

function initFieldLevelCommentWidget(fieldElement) {
  const widget = new FieldLevelCommentWidget({
    fieldNode: fieldElement,
    commentAdditionNode: fieldElement.querySelector('[data-comment-add]'),
    annotationTemplateNode: document.querySelector('#comment-icon'),
    commentApp: window.commentApp
  });
  if (widget.contentpath) {
    widget.register();
  }
}

export default {
  getContentPath,
  initComments,
  attachTabNav,
  FieldLevelCommentWidget,
  initFieldLevelCommentWidget
};