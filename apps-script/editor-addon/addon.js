// Editor Add-on: adds "Submit Review" menu to translation output docs.
// Checks for the usdr_translation_review document property set by the Translate function.

var HTTP_OK = 200;

function onOpen(e) {
  var props = PropertiesService.getDocumentProperties();
  var isTranslationReview = props.getProperty("usdr_translation_review");

  if (isTranslationReview) {
    DocumentApp.getUi()
      .createMenu("Translation Review")
      .addItem("Submit Review", "submitReview")
      .addToUi();
  }
}

function submitReview() {
  var doc = DocumentApp.getActiveDocument();
  var ui = DocumentApp.getUi();

  var confirm = ui.alert(
    "Submit Review",
    "This will submit your edits as translation feedback. Continue?",
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) return;

  var captureFeedbackUrl = PropertiesService.getScriptProperties().getProperty("CAPTURE_FEEDBACK_FUNCTION_URL");
  var token = ScriptApp.getIdentityToken();
  var options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token },
    payload: JSON.stringify({ documentId: doc.getId() }),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(captureFeedbackUrl, options);
  var result = JSON.parse(response.getContentText());

  if (response.getResponseCode() === HTTP_OK) {
    ui.alert("Review submitted successfully. " + (result.decisions || []).length + " terminology decisions captured.");
  } else {
    ui.alert("Error submitting review: " + response.getContentText());
  }
}
